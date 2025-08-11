#!/bin/bash

# Compile LD_PRELOAD interceptor for universal routing
echo "[Startup] Compiling security interceptor..."
cd /container-server/lib && make > /dev/null 2>&1
if [ $? -eq 0 ]; then
  echo "[Startup] Security interceptor compiled successfully"
else
  echo "[Startup] Warning: Failed to compile security interceptor"
fi
cd /container-server

# Function to check if Jupyter is ready
check_jupyter_ready() {
  # Check if API is responsive and kernelspecs are available
  curl -s http://localhost:8888/api/kernelspecs > /dev/null 2>&1
}

# Function to notify Bun server that Jupyter is ready
notify_jupyter_ready() {
  # Create a marker file that the Bun server can check
  touch /tmp/jupyter-ready
  echo "[Startup] Jupyter is ready, notified Bun server"
}

# Detect CAP_SYS_ADMIN capability
echo "[Startup] Detecting environment capabilities..."
HAS_CAP_SYS_ADMIN=false
if unshare --pid --fork true 2>/dev/null; then
  HAS_CAP_SYS_ADMIN=true
  echo "[Startup] CAP_SYS_ADMIN detected - control plane isolation available"
else
  echo "[Startup] No CAP_SYS_ADMIN - running in development mode"
fi

# Export capability for the Bun server to detect
export SANDBOX_HAS_CAP_SYS_ADMIN=$HAS_CAP_SYS_ADMIN

# The control plane now runs NORMALLY without isolation
# User commands will be wrapped with unshare instead
echo "[Startup] Starting control plane in default namespace..."

if [ "$HAS_CAP_SYS_ADMIN" = "true" ]; then
  echo "[Startup] Production mode: User commands will be isolated"
else
  echo "[Startup] Development mode: No isolation available"
fi

# Start Jupyter server in background (in DEFAULT namespace)
echo "[Startup] Starting Jupyter server..."
jupyter server \
  --config=/container-server/jupyter_config.py \
  > /tmp/jupyter.log 2>&1 &

JUPYTER_PID=$!

# Start Bun server immediately (in DEFAULT namespace)
echo "[Startup] Starting Bun server..."
bun index.ts &
BUN_PID=$!

# Monitor Jupyter readiness in background
(
  echo "[Startup] Monitoring Jupyter readiness in background..."
  MAX_ATTEMPTS=60
  ATTEMPT=0

  # Track start time for reporting
  START_TIME=$(date +%s.%N)

  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if check_jupyter_ready; then
      notify_jupyter_ready
      END_TIME=$(date +%s.%N)
      ELAPSED=$(awk "BEGIN {printf \"%.2f\", $END_TIME - $START_TIME}")
      echo "[Startup] Jupyter server is ready after $ELAPSED seconds ($ATTEMPT attempts)"
      break
    fi

    # Check if Jupyter process is still running
    if ! kill -0 $JUPYTER_PID 2>/dev/null; then
      echo "[Startup] WARNING: Jupyter process died. Check /tmp/jupyter.log for details"
      cat /tmp/jupyter.log
      # Don't exit - let Bun server continue running in degraded mode
      break
    fi

    ATTEMPT=$((ATTEMPT + 1))

    # Start with faster checks
    if [ $ATTEMPT -eq 1 ]; then
      DELAY=0.5  # Start at 0.5s
    else
      # Exponential backoff with 1.3x multiplier (less aggressive than 1.5x)
      DELAY=$(awk "BEGIN {printf \"%.2f\", $DELAY * 1.3}")
      # Cap at 2s max (instead of 5s)
      if [ $(awk "BEGIN {print ($DELAY > 2)}") -eq 1 ]; then
        DELAY=2
      fi
    fi

    # Log with current delay for transparency
    echo "[Startup] Jupyter not ready yet (attempt $ATTEMPT/$MAX_ATTEMPTS, next check in ${DELAY}s)"

    sleep $DELAY
  done

  if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo "[Startup] WARNING: Jupyter failed to become ready within attempts"
    echo "[Startup] Jupyter logs:"
    cat /tmp/jupyter.log
    # Don't exit - let Bun server continue in degraded mode
  fi
) &

# Wait for Bun server (main process)
wait $BUN_PID
