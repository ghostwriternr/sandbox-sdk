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
    
    const sandbox = getSandbox(env.Sandbox, "edge-case-test-" + Date.now());
    
    if (path === "/") {
      return new Response(
        "Edge Case Test Suite\n\n" +
        "Available tests:\n" +
        "  /test-all - Run all edge case tests\n" +
        "  /test-binary - Test binary data handling\n" +
        "  /test-markers - Test marker collision\n" +
        "  /test-large - Test large outputs\n" +
        "  /test-state - Test session state persistence\n",
        { headers: { "content-type": "text/plain" } }
      );
    }
    
    const tests: Array<{name: string, command: string, check: (result: any) => {passed: boolean, reason?: string}}> = [
      {
        name: "Simple ls command",
        command: "ls /",
        check: (r) => ({
          passed: r.stdout.includes("bin") && r.exitCode === 0,
          reason: r.stdout ? undefined : "No output from ls"
        })
      },
      {
        name: "Simple pwd command",
        command: "pwd",
        check: (r) => ({
          passed: r.stdout.trim() === "/workspace" && r.exitCode === 0,
          reason: `Expected /workspace, got ${r.stdout.trim()}`
        })
      },
      {
        name: "Binary data (null bytes)",
        command: "printf '\\x00\\x01\\x02\\x03\\x04'",
        check: (r) => ({
          passed: r.exitCode === 0,
          reason: "Binary output should not break execution"
        })
      },
      {
        name: "UUID marker collision",
        command: "echo 'START_$(uuidgen) END_$(uuidgen):0 DONE:test'",
        check: (r) => ({
          passed: r.stdout.includes("START_") && r.stdout.includes("END_") && r.stdout.includes("DONE:"),
          reason: "Output should contain fake markers without breaking"
        })
      },
      {
        name: "JSON-like output",
        command: "echo '{\"type\":\"result\",\"id\":\"test\",\"stdout\":\"fake\"}'",
        check: (r) => ({
          passed: r.stdout.includes('"type":"result"') && r.exitCode === 0,
          reason: "JSON output should be preserved exactly"
        })
      },
      {
        name: "Large text output (1MB)",
        command: "dd if=/dev/zero bs=1024 count=1024 2>/dev/null | base64",
        check: (r) => ({
          passed: r.stdout.length > 1000000 && r.exitCode === 0,
          reason: `Output size: ${r.stdout.length} bytes (expected > 1MB)`
        })
      },
      {
        name: "State: Change directory",
        command: "cd /tmp && pwd",
        check: (r) => ({
          passed: r.stdout.trim() === "/tmp",
          reason: `Expected /tmp, got ${r.stdout.trim()}`
        })
      },
      {
        name: "State: Verify directory persists",
        command: "pwd",
        check: (r) => ({
          passed: r.stdout.trim() === "/tmp",
          reason: `Directory should still be /tmp, got ${r.stdout.trim()}`
        })
      },
      {
        name: "State: Set environment variable",
        command: "export MY_TEST_VAR='hello world' && echo $MY_TEST_VAR",
        check: (r) => ({
          passed: r.stdout.trim() === "hello world",
          reason: `Expected 'hello world', got ${r.stdout.trim()}`
        })
      },
      {
        name: "State: Verify env var persists",
        command: "echo $MY_TEST_VAR",
        check: (r) => ({
          passed: r.stdout.trim() === "hello world",
          reason: `Env var should still be 'hello world', got ${r.stdout.trim()}`
        })
      },
      {
        name: "Unicode and special chars",
        command: "echo '🚀 Hello\\tWorld\\n✨'",
        check: (r) => ({
          passed: r.stdout.includes("🚀") && r.stdout.includes("✨"),
          reason: "Unicode should be preserved"
        })
      },
      {
        name: "Command with quotes and escapes",
        command: "echo \"It's a \\\"test\\\" with \$HOME\"",
        check: (r) => ({
          passed: r.stdout.includes("It's a") && r.stdout.includes('"test"'),
          reason: "Quotes and escapes should be handled correctly"
        })
      },
      {
        name: "Exit code propagation",
        command: "exit 42",
        check: (r) => ({
          passed: r.exitCode === 42,
          reason: `Exit code should be 42, got ${r.exitCode}`
        })
      },
      {
        name: "Stderr capture",
        command: "echo 'This is stderr' >&2",
        check: (r) => ({
          passed: r.stderr.trim() === "This is stderr" && r.stdout === "",
          reason: `Stderr: '${r.stderr.trim()}', Stdout: '${r.stdout}'`
        })
      },
      {
        name: "Mixed stdout/stderr",
        command: "echo 'stdout line' && echo 'stderr line' >&2",
        check: (r) => ({
          passed: r.stdout.trim() === "stdout line" && r.stderr.trim() === "stderr line",
          reason: "Both streams should be captured separately"
        })
      },
      {
        name: "Command not found",
        command: "nonexistentcommand123",
        check: (r) => ({
          passed: r.exitCode !== 0 && r.stderr.includes("not found"),
          reason: "Should fail with 'not found' error"
        })
      },
      {
        name: "Multiline output",
        command: "echo -e 'line1\\nline2\\nline3'",
        check: (r) => ({
          passed: r.stdout.split('\n').length >= 3,
          reason: `Expected 3+ lines, got ${r.stdout.split('\n').length}`
        })
      },
      {
        name: "Background process (sleep)",
        command: "sleep 0.1 &",
        check: (r) => ({
          passed: r.exitCode === 0,
          reason: "Background process should not block"
        })
      },
      {
        name: "File creation and reading",
        command: "echo 'test content' > /tmp/test.txt && cat /tmp/test.txt",
        check: (r) => ({
          passed: r.stdout.trim() === "test content",
          reason: `Expected 'test content', got '${r.stdout.trim()}'`
        })
      },
      {
        name: "Verify file persists",
        command: "cat /tmp/test.txt",
        check: (r) => ({
          passed: r.stdout.trim() === "test content",
          reason: "File should still exist from previous command"
        })
      }
    ];
    
    if (path === "/test-binary") {
      // Special binary test
      const result = await sandbox.exec("head -c 1000 /dev/urandom | base64");
      return Response.json({
        test: "Binary data handling",
        passed: result.exitCode === 0 && result.stdout.length > 1000,
        outputLength: result.stdout.length,
        exitCode: result.exitCode
      });
    }
    
    if (path === "/test-markers") {
      // Test our exact marker format
      const uuid = crypto.randomUUID();
      const command = `echo "START_${uuid}" && echo "END_${uuid}:0" && echo "DONE:${uuid}"`;
      const result = await sandbox.exec(command);
      return Response.json({
        test: "Marker collision",
        passed: result.stdout.includes(`START_${uuid}`) && 
                result.stdout.includes(`END_${uuid}:0`) && 
                result.stdout.includes(`DONE:${uuid}`),
        command,
        output: result.stdout
      });
    }
    
    if (path === "/test-large") {
      // Test very large output
      const result = await sandbox.exec("dd if=/dev/zero bs=1024 count=10240 2>/dev/null | base64");
      return Response.json({
        test: "Large output (10MB)",
        passed: result.exitCode === 0 && result.stdout.length > 10000000,
        outputSize: `${(result.stdout.length / 1024 / 1024).toFixed(2)} MB`,
        exitCode: result.exitCode
      });
    }
    
    if (path === "/test-state") {
      // Test session state persistence
      await sandbox.exec("cd /var && export TEST=123");
      const pwd = await sandbox.exec("pwd");
      const env = await sandbox.exec("echo $TEST");
      
      return Response.json({
        test: "Session state",
        passed: pwd.stdout.trim() === "/var" && env.stdout.trim() === "123",
        pwd: pwd.stdout.trim(),
        env: env.stdout.trim()
      });
    }
    
    if (path === "/test-all") {
      const results = [];
      
      for (const test of tests) {
        try {
          console.log(`Running test: ${test.name}`);
          const result = await sandbox.exec(test.command);
          const checkResult = test.check(result);
          results.push({
            name: test.name,
            passed: checkResult.passed,
            reason: checkResult.reason,
            result: {
              stdout: result.stdout.substring(0, 200),
              stderr: result.stderr.substring(0, 200),
              exitCode: result.exitCode
            }
          });
        } catch (error) {
          results.push({
            name: test.name,
            passed: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      
      const passed = results.filter(r => r.passed).length;
      const failed = results.filter(r => !r.passed).length;
      
      return Response.json({
        summary: {
          total: results.length,
          passed,
          failed,
          status: failed === 0 ? "✅ ALL TESTS PASSED!" : `❌ ${failed} tests failed`
        },
        results
      });
    }
    
    return new Response("Not found", { status: 404 });
  }
};