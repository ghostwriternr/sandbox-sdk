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
          "  /test-comprehensive - Complete security validation (current + future)\n",
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

      // Test 4: Comprehensive Isolation Test (Current + Future)
      if (path === "/test-namespace-isolation" || path === "/test-comprehensive") {
        console.log("🔒 Testing Comprehensive Security Isolation...\n");
        
        const tests = [];
        const sandbox = getSandbox(env.Sandbox, "comprehensive-test-" + Date.now());
        
        // Check implementation status
        const hasNewMethods = 
          typeof sandbox.execWithSecrets === 'function' &&
          typeof sandbox.startProcessWithSecrets === 'function';
        
        tests.push({
          test: "Implementation Status",
          result: hasNewMethods ? "✅ v2.0 (Namespace Isolation)" : "⚠️ v1.x (Current - Vulnerable)",
          hasNewMethods
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
          } catch (error: any) {
            tests.push({
              test: "Current: setEnvVars() exposure",
              result: "✅ Method removed (good!)",
              error: error.message
            });
          }
        }
        
        // If new methods exist, test them
        if (hasNewMethods) {
          console.log("Testing v2.0 namespace isolation...\n");
        
        // Test 1: Basic isolation - secrets not visible across namespaces
        try {
          // Execute with secrets in isolated namespace
          const isolatedResult = await sandbox.execWithSecrets(
            'echo "KEY=$TEST_SECRET_KEY"',
            {
              env: {
                TEST_SECRET_KEY: 'SUPER_SECRET_VALUE_12345',
                AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE'
              }
            }
          );
          
          tests.push({
            test: "Isolated execution with secrets",
            result: isolatedResult.isolated ? "✅ Ran in isolated namespace" : "❌ Not isolated",
            output: isolatedResult.stdout.trim()
          });
          
          // Try to access from main namespace
          const mainResult = await sandbox.exec('echo "KEY=$TEST_SECRET_KEY"');
          tests.push({
            test: "Main namespace cannot see secrets",
            result: mainResult.stdout.includes('SUPER_SECRET') ? "❌ LEAKED!" : "✅ PROTECTED",
            output: mainResult.stdout.trim() || "(empty - good!)"
          });
        } catch (error: any) {
          tests.push({
            test: "Basic isolation",
            result: "❌ Error",
            error: error.message
          });
        }
        
        // Test 2: Process visibility isolation
        try {
          // Start isolated process with secrets
          const isolatedProc = await sandbox.startProcessWithSecrets(
            'sh -c "echo Started with SECRET=$DATABASE_PASSWORD && sleep 10"',
            {
              env: {
                DATABASE_PASSWORD: 'prod-db-password-123',
                API_KEY: 'sk-secret-api-key'
              }
            }
          );
          
          tests.push({
            test: "Started isolated process",
            result: `PID: ${isolatedProc.pid}, ID: ${isolatedProc.id}`
          });
          
          // Check if visible in process list
          const processList = await sandbox.listProcesses();
          const isVisible = processList.some(p => p.id === isolatedProc.id);
          
          tests.push({
            test: "Isolated process hidden from list",
            result: isVisible ? "❌ VISIBLE (bad)" : "✅ HIDDEN (good)",
            totalProcesses: processList.length
          });
          
          // Try to read its environment
          if (isolatedProc.pid) {
            const envRead = await sandbox.exec(
              `cat /proc/${isolatedProc.pid}/environ 2>&1 | tr '\\0' '\\n' | grep -E '(DATABASE_PASSWORD|API_KEY)' || echo 'Not found'`
            );
            tests.push({
              test: `Cannot read /proc/${isolatedProc.pid}/environ`,
              result: envRead.stdout.includes('prod-db-password') ? "❌ EXPOSED" : "✅ PROTECTED",
              output: envRead.stdout.trim()
            });
          }
          
          // Clean up
          await sandbox.killProcess(isolatedProc.id).catch(() => {});
          
        } catch (error: any) {
          tests.push({
            test: "Process isolation",
            result: "❌ Error",
            error: error.message
          });
        }
        
        // Test 3: File system sharing (files should be shared)
        try {
          const filename = `/tmp/namespace_test_${Date.now()}.txt`;
          
          // Write file in isolated namespace
          await sandbox.execWithSecrets(
            `echo "Written in isolated namespace with SECRET=$SECRET_VALUE" > ${filename}`,
            {
              env: { SECRET_VALUE: 'should-not-leak' }
            }
          );
          
          // Read from main namespace
          const readResult = await sandbox.exec(`cat ${filename}`);
          const fileAccessible = readResult.exitCode === 0;
          const containsSecret = readResult.stdout.includes('should-not-leak');
          
          tests.push({
            test: "File system is shared",
            result: fileAccessible ? "✅ Files accessible" : "❌ Files not shared",
            secretInFile: containsSecret ? "Yes (expected in file)" : "No"
          });
          
          // Clean up
          await sandbox.exec(`rm ${filename}`);
          
        } catch (error: any) {
          tests.push({
            test: "File system sharing",
            result: "❌ Error",
            error: error.message
          });
        }
        
        // Test 4: Real-world AWS CLI test (if credentials available)
        if (url.searchParams.get('test-aws') === 'true') {
          try {
            const awsResult = await sandbox.execWithSecrets(
              'aws sts get-caller-identity',
              {
                env: {
                  AWS_ACCESS_KEY_ID: env.TEST_AWS_KEY || 'test-key',
                  AWS_SECRET_ACCESS_KEY: env.TEST_AWS_SECRET || 'test-secret',
                  AWS_DEFAULT_REGION: 'us-east-1'
                }
              }
            );
            
            tests.push({
              test: "AWS CLI with isolated credentials",
              result: awsResult.exitCode === 0 ? "✅ SUCCESS" : "❌ FAILED",
              isolated: awsResult.isolated,
              output: awsResult.stdout.substring(0, 100)
            });
            
            // Verify credentials not in main namespace
            const mainAwsCheck = await sandbox.exec('aws sts get-caller-identity 2>&1');
            tests.push({
              test: "Main namespace cannot use AWS",
              result: mainAwsCheck.exitCode !== 0 ? "✅ No credentials" : "❌ Has credentials!"
            });
            
          } catch (error: any) {
            tests.push({
              test: "AWS CLI test",
              result: "⚠️ Skipped",
              reason: "No AWS credentials or error",
              error: error.message
            });
          }
        }
        
        // Test 5: Performance benchmark
        try {
          const iterations = 10;
          const normalTimings: number[] = [];
          const isolatedTimings: number[] = [];
          
          // Benchmark normal execution
          for (let i = 0; i < iterations; i++) {
            const start = Date.now();
            await sandbox.exec('true');
            normalTimings.push(Date.now() - start);
          }
          
          // Benchmark isolated execution
          for (let i = 0; i < iterations; i++) {
            const start = Date.now();
            await sandbox.execWithSecrets('true', {
              env: { ITERATION: String(i) }
            });
            isolatedTimings.push(Date.now() - start);
          }
          
          const avgNormal = normalTimings.reduce((a, b) => a + b) / iterations;
          const avgIsolated = isolatedTimings.reduce((a, b) => a + b) / iterations;
          const overhead = avgIsolated - avgNormal;
          
          tests.push({
            test: "Performance overhead",
            result: overhead < 10 ? "✅ Acceptable" : "⚠️ High overhead",
            normalAvg: `${avgNormal.toFixed(2)}ms`,
            isolatedAvg: `${avgIsolated.toFixed(2)}ms`,
            overhead: `${overhead.toFixed(2)}ms`
          });
          
        } catch (error: any) {
          tests.push({
            test: "Performance benchmark",
            result: "❌ Error",
            error: error.message
          });
        }
        
        // Summary
        const passed = tests.filter(t => t.result?.includes('✅')).length;
        const failed = tests.filter(t => t.result?.includes('❌')).length;
        const warnings = tests.filter(t => t.result?.includes('⚠️')).length;
        const vulnerabilities = tests.filter(t => t.isVulnerable).length;
        
        // Determine overall security status
        let overallStatus = 'UNKNOWN';
        let statusMessage = '';
        
        if (hasNewMethods && failed === 0) {
          overallStatus = 'SECURE';
          statusMessage = '🎉 Namespace isolation working correctly!';
        } else if (hasNewMethods && failed > 0) {
          overallStatus = 'PARTIAL';
          statusMessage = '⚠️ Namespace isolation implemented but has issues';
        } else if (vulnerabilities > 0) {
          overallStatus = 'VULNERABLE';
          statusMessage = '🚨 Current implementation exposes secrets to all code';
        }
        
        return Response.json({
          summary: {
            total: tests.length,
            passed,
            failed,
            warnings,
            vulnerabilities,
            status: overallStatus,
            message: statusMessage,
            implementation: hasNewMethods ? 'v2.0 (with isolation)' : 'v1.x (without isolation)'
          },
          tests
        }, {
          headers: { "content-type": "application/json" },
          status: 200  // Always 200 for test results
        });
      }

      return new Response(
        "Unknown path. Try: /test-capabilities, /test-isolation, /test-processes, or /test-comprehensive",
        { status: 404 }
      );

    } catch (error: any) {
      console.error("Error:", error);
      return new Response(`Error: ${error.message}`, { 
        status: 500,
        headers: { "content-type": "text/plain" }
      });
    }
  },
};