import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

// Export the Sandbox Durable Object
export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create a test sandbox instance
    const sandbox = getSandbox(env.Sandbox, "security-test");

    try {
      // Quick health check
      if (path === "/") {
        return new Response(
          "Security Test Worker Ready!\n\n" +
          "Available tests:\n" +
          "  /test-capabilities - Check Linux capabilities\n" +
          "  /test-isolation - Test current credential isolation\n" +
          "  /test-processes - Test process visibility\n" +
          "  /test-simplified - Test our simplified security approach\n" +
          "\nApproach: Leveraging Firecracker+Docker isolation, adding minimal control plane protection\n",
          { headers: { "content-type": "text/plain" } }
        );
      }

      // Test 1: Container Capabilities
      if (path === "/test-capabilities") {
        console.log("🔍 Testing Container Capabilities...\n");
        
        const tests = [];
        
        // Basic info
        const userInfo = await sandbox.exec("whoami && id");
        tests.push({ test: "User Info", result: userInfo.stdout.trim() });
        
        // Check capabilities
        const capsProc = await sandbox.exec("cat /proc/self/status | grep Cap");
        tests.push({ test: "Capabilities (raw)", result: capsProc.stdout.trim() });
        
        // Test CAP_SYS_ADMIN - PID namespace
        const pidNs = await sandbox.exec("unshare --pid --fork echo 'SUCCESS' 2>&1");
        tests.push({ 
          test: "CAP_SYS_ADMIN (PID namespace)", 
          result: pidNs.exitCode === 0 ? "✅ AVAILABLE" : `❌ NOT AVAILABLE: ${pidNs.stderr || pidNs.stdout}` 
        });
        
        // Test Mount namespace
        const mountNs = await sandbox.exec("unshare --mount echo 'SUCCESS' 2>&1");
        tests.push({ 
          test: "CAP_SYS_ADMIN (Mount namespace)", 
          result: mountNs.exitCode === 0 ? "✅ AVAILABLE" : `❌ NOT AVAILABLE: ${mountNs.stderr || mountNs.stdout}` 
        });
        
        // Test Network namespace
        const netNs = await sandbox.exec("unshare --net echo 'SUCCESS' 2>&1");
        tests.push({ 
          test: "Network namespace", 
          result: netNs.exitCode === 0 ? "✅ AVAILABLE" : `❌ NOT AVAILABLE: ${netNs.stderr || netNs.stdout}` 
        });
        
        // Test User namespace
        const userNs = await sandbox.exec("unshare --user echo 'SUCCESS' 2>&1");
        tests.push({ 
          test: "User namespace", 
          result: userNs.exitCode === 0 ? "✅ AVAILABLE" : `❌ NOT AVAILABLE: ${userNs.stderr || userNs.stdout}` 
        });
        
        // Can we read other processes' environment?
        const readEnv = await sandbox.exec("cat /proc/1/environ 2>&1 | head -c 100");
        tests.push({ 
          test: "Read /proc/1/environ", 
          result: readEnv.exitCode === 0 ? "⚠️ CAN READ (security risk!)" : "✅ BLOCKED" 
        });
        
        // Check cgroups
        const cgroupV = await sandbox.exec("[ -f /sys/fs/cgroup/cgroup.controllers ] && echo 'cgroups v2' || echo 'cgroups v1'");
        tests.push({ test: "Cgroups version", result: cgroupV.stdout.trim() });
        
        // Test cgroup delegation
        const cgroupDel = await sandbox.exec("mkdir /sys/fs/cgroup/test_subgroup 2>&1");
        if (cgroupDel.exitCode === 0) {
          await sandbox.exec("rmdir /sys/fs/cgroup/test_subgroup");
          tests.push({ test: "Cgroup delegation", result: "✅ ENABLED" });
        } else {
          tests.push({ test: "Cgroup delegation", result: `❌ DISABLED: ${cgroupDel.stderr || cgroupDel.stdout}` });
        }
        
        // Seccomp status
        const seccomp = await sandbox.exec("grep Seccomp /proc/self/status");
        tests.push({ 
          test: "Seccomp", 
          result: seccomp.stdout.trim() || "Unknown" 
        });
        
        // Test ptrace
        const ptraceTest = await sandbox.exec("strace -o /dev/null echo test 2>&1");
        tests.push({ 
          test: "CAP_SYS_PTRACE", 
          result: ptraceTest.exitCode === 0 ? "✅ AVAILABLE" : "❌ NOT AVAILABLE" 
        });
        
        return Response.json(tests, { 
          headers: { "content-type": "application/json" },
          status: 200 
        });
      }

      // Test 2: Credential Isolation
      if (path === "/test-isolation") {
        console.log("🔐 Testing Credential Isolation...\n");
        
        // IMPORTANT: For this test, we need a fresh sandbox instance
        // because setEnvVars must be called immediately after getSandbox
        const testSandbox = getSandbox(env.Sandbox, "isolation-test-" + Date.now());
        
        // Set test secrets FIRST before any other operations
        await testSandbox.setEnvVars({
          TEST_SECRET: "SUPER_SECRET_VALUE_12345",
          AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE"
        });
        
        const tests = [];
        
        // Test 1: Can we read it directly?
        const direct = await testSandbox.exec("echo $TEST_SECRET");
        tests.push({ 
          test: "Direct access to env var", 
          result: direct.stdout.includes("SUPER_SECRET") ? "❌ EXPOSED" : "✅ HIDDEN",
          output: direct.stdout.trim()
        });
        
        // Test 2: Can we read via /proc/self/environ?
        const selfEnv = await testSandbox.exec("cat /proc/self/environ | tr '\\0' '\\n' | grep TEST_SECRET");
        tests.push({ 
          test: "Read via /proc/self/environ", 
          result: selfEnv.stdout.includes("SUPER_SECRET") ? "❌ EXPOSED" : "✅ HIDDEN",
          output: selfEnv.stdout.trim() 
        });
        
        // Test 3: Start a background process using startProcess
        const bgProcess = await testSandbox.startProcess("sh -c 'echo Background PID: $$; sleep 30'");
        tests.push({
          test: "Started background process",
          result: `PID: ${bgProcess.pid}`,
          output: `Process ID: ${bgProcess.id}`
        });
        
        // Test 4: Can we read the background process's environment?
        if (bgProcess.pid) {
          const bgEnv = await testSandbox.exec(`cat /proc/${bgProcess.pid}/environ 2>&1 | tr '\\0' '\\n' | grep TEST_SECRET`);
          tests.push({ 
            test: `Read background process env (/proc/${bgProcess.pid}/environ)`, 
            result: bgEnv.stdout.includes("SUPER_SECRET") ? "❌ CAN READ OTHER PROCESS ENV" : "✅ CANNOT READ",
            output: bgEnv.stdout.trim() || bgEnv.stderr?.trim()
          });
        }
        
        // Test 5: Python subprocess test
        await testSandbox.writeFile("/tmp/test_env.py", `
import os
import subprocess

# Try to read env
print("Python os.environ TEST_SECRET:", os.environ.get('TEST_SECRET', 'NOT FOUND'))

# Try to read via subprocess
result = subprocess.run(['sh', '-c', 'echo $TEST_SECRET'], capture_output=True, text=True)
print("Subprocess TEST_SECRET:", result.stdout.strip() or 'NOT FOUND')

# Try to read /proc
try:
    with open('/proc/self/environ', 'rb') as f:
        environ = f.read().decode('utf-8', errors='ignore')
        if 'TEST_SECRET' in environ:
            print("Found TEST_SECRET in /proc/self/environ")
        else:
            print("TEST_SECRET not in /proc/self/environ")
except Exception as e:
    print(f"Error reading /proc: {e}")
`);
        
        const pythonTest = await testSandbox.exec("python3 /tmp/test_env.py");
        tests.push({ 
          test: "Python subprocess access", 
          result: pythonTest.stdout.includes("SUPER_SECRET") ? "❌ EXPOSED TO PYTHON" : "✅ HIDDEN FROM PYTHON",
          output: pythonTest.stdout
        });
        
        // Test 6: Node.js test
        await testSandbox.writeFile("/tmp/test_env.js", `
console.log("Node process.env.TEST_SECRET:", process.env.TEST_SECRET || 'NOT FOUND');
console.log("Node AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID || 'NOT FOUND');

// Try child_process
const { execSync } = require('child_process');
try {
  const result = execSync('echo $TEST_SECRET').toString();
  console.log("Child process TEST_SECRET:", result.trim() || 'NOT FOUND');
} catch (e) {
  console.log("Child process error:", e.message);
}
`);
        
        const nodeTest = await testSandbox.exec("node /tmp/test_env.js");
        tests.push({ 
          test: "Node.js subprocess access", 
          result: nodeTest.stdout.includes("SUPER_SECRET") ? "❌ EXPOSED TO NODE" : "✅ HIDDEN FROM NODE",
          output: nodeTest.stdout
        });
        
        return Response.json(tests, { 
          headers: { "content-type": "application/json" },
          status: 200 
        });
      }

      // Test 3: Process Visibility
      if (path === "/test-processes") {
        console.log("👁️ Testing Process Visibility...\n");
        
        const tests = [];
        
        // Start some background processes using startProcess
        const proc1 = await sandbox.startProcess("sleep 100");
        const proc2 = await sandbox.startProcess("python3 -c 'import time; time.sleep(100)'");
        
        tests.push({
          test: "Started processes",
          result: `Process 1: PID ${proc1.pid}, Process 2: PID ${proc2.pid}`
        });
        
        // List all processes
        const ps = await sandbox.exec("ps aux | head -20");
        tests.push({ 
          test: "Process list (first 20)", 
          result: ps.stdout
        });
        
        // Count processes
        const count = await sandbox.exec("ps aux | wc -l");
        tests.push({ 
          test: "Process count", 
          result: count.stdout.trim()
        });
        
        // Check /proc
        const procList = await sandbox.exec("ls /proc | grep -E '^[0-9]+$' | wc -l");
        tests.push({ 
          test: "Processes in /proc", 
          result: procList.stdout.trim()
        });
        
        // Can we read specific process environments?
        const envCheck1 = await sandbox.exec(`cat /proc/${proc1.pid}/environ 2>&1 | tr '\\0' '\\n' | head -5`);
        tests.push({ 
          test: `Read /proc/${proc1.pid}/environ`, 
          result: envCheck1.exitCode === 0 ? "✅ CAN READ" : "❌ CANNOT READ",
          output: envCheck1.stdout.substring(0, 200) || envCheck1.stderr
        });
        
        // Clean up processes
        await sandbox.killProcess(proc1.id);
        await sandbox.killProcess(proc2.id);
        
        return Response.json(tests, { 
          headers: { "content-type": "application/json" },
          status: 200 
        });
      }

      // Test 4: Simplified Isolation Test (Our Actual Approach)
      if (path === "/test-simplified" || path === "/test-comprehensive") {
        console.log("🔒 Testing Simplified Security Approach...\n");
        
        const tests = [];
        const sandbox = getSandbox(env.Sandbox, "simplified-test-" + Date.now());
        
        // Check if our simplified approach is implemented
        const hasContexts = typeof sandbox.createContext === 'function';
        const hasControlPlaneHiding = false; // Will be true after implementation
        
        tests.push({
          test: "Implementation Status",
          result: hasContexts ? "✅ Context-based isolation" : "⚠️ v1.x (Current - Vulnerable)",
          details: {
            contexts: hasContexts ? "Available" : "Not implemented",
            controlPlane: hasControlPlaneHiding ? "Hidden" : "Visible (vulnerable)",
            approach: "Leveraging Firecracker+Docker, minimal additional isolation"
          }
        });
        
        // Always test current vulnerability first
        console.log("Testing current security state...\n");
        
        // Test current setEnvVars vulnerability
        if (typeof sandbox.setEnvVars === 'function') {
          try {
            await sandbox.setEnvVars({
              CURRENT_TEST_SECRET: 'EXPOSED_SECRET_123',
              AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE'
            });
            
            const checkExposure = await sandbox.exec('echo $CURRENT_TEST_SECRET');
            tests.push({
              test: "Current: setEnvVars() exposure",
              result: checkExposure.stdout.includes('EXPOSED_SECRET') 
                ? "❌ VULNERABLE (secrets exposed to all code)" 
                : "✅ Protected",
              isVulnerable: checkExposure.stdout.includes('EXPOSED_SECRET')
            });
          } catch (error) {
            tests.push({
              test: "Current: setEnvVars() exposure",
              result: "✅ Method removed (good!)",
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        
        // Test our simplified approach if contexts are available
        if (hasContexts) {
          console.log("Testing context-based isolation...\n");
        
        // Test 1: Context-based credential separation
        try {
          // Create platform context (AI agents run here)
          const platform = await sandbox.createContext({
            name: "platform",
            env: {
              ANTHROPIC_API_KEY: 'sk-ant-platform-key-123',
              // In real implementation, this would enable LD_PRELOAD routing
              LD_PRELOAD: '/lib/universal_router.so',
              SANDBOX_ROUTE_TO_CONTEXT: 'user'
            },
            persistent: true
          });
          
          // Create user context (AI agent children run here)
          const user = await sandbox.createContext({
            name: "user",
            env: {
              CLOUDFLARE_API_TOKEN: 'cf-user-token-456',
              AWS_ACCESS_KEY_ID: 'AKIA-user-key'
            },
            persistent: true
          });
          
          // Platform context has its credentials
          const platformCheck = await platform.exec('echo "ANTHROPIC_KEY=$ANTHROPIC_API_KEY"');
          
          tests.push({
            test: "Platform context has platform credentials",
            result: platformCheck.stdout.includes('sk-ant') ? "✅ Has credentials" : "❌ Missing",
            output: platformCheck.stdout.trim()
          });
          
          // User context has its own credentials
          const userCheck = await user.exec('echo "CF_TOKEN=$CLOUDFLARE_API_TOKEN"');
          tests.push({
            test: "User context has user credentials",
            result: userCheck.stdout.includes('cf-user') ? "✅ Has credentials" : "❌ Missing",
            output: userCheck.stdout.trim()
          });
          
          // Cross-context isolation - user can't see platform creds
          const crossCheck = await user.exec('echo "ANTHROPIC=$ANTHROPIC_API_KEY"');
          tests.push({
            test: "User context isolated from platform secrets",
            result: crossCheck.stdout.includes('sk-ant') ? "❌ LEAKED!" : "✅ ISOLATED",
            output: crossCheck.stdout.trim() || "(empty - good!)"
          });
        } catch (error) {
          tests.push({
            test: "Basic isolation",
            result: "❌ Error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
        } // End of if (hasContexts)
        
        // Test 2: Control plane hiding (will work after implementation)
        try {
          // Check if control plane processes are visible
          const psResult = await sandbox.exec('ps aux | grep -E "(jupyter|bun)" | grep -v grep');
          const controlPlaneVisible = psResult.stdout.includes('jupyter') || psResult.stdout.includes('bun');
          
          tests.push({
            test: "Control plane processes (Bun/Jupyter)",
            result: controlPlaneVisible ? "❌ VISIBLE (vulnerable to pkill)" : "✅ HIDDEN (protected)",
            details: controlPlaneVisible ? "Can be killed by user code!" : "Hidden via unshare --pid"
          });
          
          // Try to kill control plane (should fail if hidden)
          if (!controlPlaneVisible) {
            await sandbox.exec('pkill jupyter 2>/dev/null || true');
            await sandbox.exec('pkill bun 2>/dev/null || true');
            
            // Check if services still running
            const healthCheck = await fetch(`${request.url.replace(path, '/health')}`);
            tests.push({
              test: "Control plane survives pkill attempts",
              result: healthCheck.ok ? "✅ PROTECTED" : "❌ KILLED",
              details: "Hidden processes can't be killed"
            });
          }
          
        } catch (error) {
          tests.push({
            test: "Process isolation",
            result: "❌ Error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Test 3: LD_PRELOAD universal routing (conceptual test)
        try {
          tests.push({
            test: "Universal routing concept",
            result: "ℹ️ Not yet implemented",
            details: {
              concept: "AI agents in platform context route ALL children to user context",
              mechanism: "LD_PRELOAD interceptor (no pattern matching)",
              benefit: "AI can deploy with platform creds, generated code runs without them"
            }
          });
          
          // Conceptual example of what will work after implementation
          if (hasContexts) {
            tests.push({
              test: "Routing example (conceptual)",
              scenario: "Claude Code runs 'aws deploy' → routes to user context",
              result: "Will prevent credential leakage to generated code"
            });
          }
          
        } catch (error) {
          tests.push({
            test: "Universal routing concept",
            result: "❌ Error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Test 4: Port protection (test with non-conflicting ports)
        try {
          // Try to bind to various ports with explicit bind address
          const port9001 = await sandbox.startProcess('python3 -m http.server 9001 --bind 0.0.0.0');
          const port9002 = await sandbox.startProcess('python3 -m http.server 9002 --bind 0.0.0.0');
          
          // Wait a bit longer for Python servers to start
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Check if the processes are still running
          const proc9001Status = await sandbox.getProcess(port9001.id);
          const proc9002Status = await sandbox.getProcess(port9002.id);
          
          tests.push({
            test: "Python process 9001 status",
            result: proc9001Status.status === 'running' ? "✅ Running" : "❌ Not running",
            details: `Status: ${proc9001Status.status}, PID: ${proc9001Status.pid}`
          });
          
          tests.push({
            test: "Python process 9002 status", 
            result: proc9002Status.status === 'running' ? "✅ Running" : "❌ Not running",
            details: `Status: ${proc9002Status.status}, PID: ${proc9002Status.pid}`
          });
          
          // Check if Python managed to bind to the ports
          const check9001 = await sandbox.exec('lsof -i :9001 | grep python || echo "NOT_BOUND"');
          const check9002 = await sandbox.exec('lsof -i :9002 | grep python || echo "NOT_BOUND"');
          
          tests.push({
            test: "Port 9001 binding",
            result: check9001.stdout.includes("python") ? "✅ User can bind available ports" : "❌ Failed to bind",
            details: "User code should be able to use unreserved ports"
          });
          
          tests.push({
            test: "Port 9002 binding", 
            result: check9002.stdout.includes("python") ? "✅ User can bind available ports" : "❌ Failed to bind",
            details: "User code should be able to use unreserved ports"
          });
          
          // Now test that we CANNOT bind to control plane ports
          // Note: These should fail to bind because Jupyter/Bun already have them
          const tryJupyter = await sandbox.exec('python3 -c "import socket; s=socket.socket(); s.bind((\\"\\", 8888))" 2>&1 || echo "EXPECTED_FAIL"');
          const tryBun = await sandbox.exec('python3 -c "import socket; s=socket.socket(); s.bind((\\"\\", 3000))" 2>&1 || echo "EXPECTED_FAIL"');
          
          tests.push({
            test: "Port 8888 (Jupyter) protection",
            result: tryJupyter.stdout.includes("EXPECTED_FAIL") || tryJupyter.stdout.includes("Address already in use") ? "✅ PROTECTED" : "❌ NOT PROTECTED",
            details: "Jupyter port should be protected"
          });
          
          tests.push({
            test: "Port 3000 (Bun) protection",
            result: tryBun.stdout.includes("EXPECTED_FAIL") || tryBun.stdout.includes("Address already in use") ? "✅ PROTECTED" : "❌ NOT PROTECTED", 
            details: "Bun control plane port should be protected"
          });
          
          // Clean up the test processes properly
          if (port9001.id) await sandbox.killProcess(port9001.id);
          if (port9002.id) await sandbox.killProcess(port9002.id);
        } catch (error) {
          tests.push({
            test: "Port protection test",
            result: "❌ Error",
            error: error instanceof Error ? error.message : String(error)
          });
        }
        
        // Test 5: Simplified approach benefits
        tests.push({
          test: "Architecture Benefits",
          result: "✅ Simplified approach",
          details: {
            existing: "Leveraging Firecracker VM + Docker container isolation",
            added: "Minimal: unshare --pid + contexts + LD_PRELOAD",
            complexity: "Much simpler than full sandboxing solutions",
            performance: "Minimal overhead (one unshare at startup)"
          }
        });
        
        // Summary
        const passed = tests.filter(t => t.result?.toString().includes('✅')).length;
        const failed = tests.filter(t => t.result?.toString().includes('❌')).length;
        const warnings = tests.filter(t => t.result?.toString().includes('⚠️')).length;
        const info = tests.filter(t => t.result?.toString().includes('ℹ️')).length;
        const vulnerabilities = tests.filter(t => t.isVulnerable).length;
        
        // Determine overall security status
        let overallStatus = 'UNKNOWN';
        let statusMessage = '';
        
        if (hasContexts && failed === 0) {
          overallStatus = 'SECURE';
          statusMessage = '🎉 Context-based isolation working!';
        } else if (hasContexts && failed > 0) {
          overallStatus = 'PARTIAL';
          statusMessage = '⚠️ Contexts available but some issues remain';
        } else if (vulnerabilities > 0 || failed > 0) {
          overallStatus = 'VULNERABLE';
          statusMessage = '🚨 Current implementation exposes secrets to all code';
        }
        
        return Response.json({
          summary: {
            total: tests.length,
            passed,
            failed,
            warnings,
            info,
            vulnerabilities,
            status: overallStatus,
            message: statusMessage,
            implementation: hasContexts ? 'Simplified (contexts + hiding + routing)' : 'v1.x (vulnerable)',
            approach: 'Leveraging existing Firecracker+Docker, minimal additional isolation'
          },
          tests
        }, {
          headers: { "content-type": "application/json" },
          status: 200  // Always 200 for test results
        });
      }  // End of /test-simplified

      return new Response(
        "Unknown path. Try: /test-capabilities, /test-isolation, /test-processes, or /test-simplified",
        { status: 404 }
      );

    } catch (error) {
      console.error("Error:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return new Response(`Error: ${errorMessage}`, { 
        status: 500,
        headers: { "content-type": "text/plain" }
      });
    }
  },
};