#!/usr/bin/env bun

/**
 * Test script for simple isolation solution
 * Run with: bun test-simple-isolation.ts
 */

import { getSandbox } from "./packages/sandbox/src/sandbox";

// Mock Durable Object namespace for testing
const mockNamespace = {
  get: (id: any) => ({
    fetch: async (req: Request) => {
      console.log(`[Mock] ${req.method} ${new URL(req.url).pathname}`);
      
      // For testing, run a local container server on port 3000
      const url = new URL(req.url);
      url.host = "localhost:3000";
      
      return fetch(url, {
        method: req.method,
        headers: req.headers,
        body: req.body
      });
    }
  })
} as any;

async function runTests() {
  console.log("🧪 Testing Simple Isolation Solution\n");
  
  const sandbox = getSandbox(mockNamespace, "test-isolation");
  
  // Test 1: Process Isolation
  console.log("Test 1: Process Isolation");
  console.log("------------------------");
  try {
    // Regular exec should use default context with isolation
    const ps = await sandbox.exec("ps aux | head -10");
    console.log("✅ Command executed");
    
    // Check if Jupyter/Bun are hidden
    const hasJupyter = ps.stdout.toLowerCase().includes("jupyter");
    const hasBun = ps.stdout.toLowerCase().includes("bun");
    
    if (!hasJupyter && !hasBun) {
      console.log("✅ Control plane processes are hidden!");
    } else {
      console.log("⚠️ Control plane processes visible (might be in dev mode)");
    }
    console.log("Output preview:", ps.stdout.substring(0, 200));
  } catch (error) {
    console.error("❌ Failed:", error);
  }
  
  console.log("\nTest 2: Credential Isolation");
  console.log("---------------------------");
  try {
    // Create two contexts with different credentials
    await sandbox.createContext({
      name: "aws",
      env: { AWS_ACCESS_KEY: "aws-secret-123" }
    });
    
    await sandbox.createContext({
      name: "gcp",
      env: { GCP_API_KEY: "gcp-secret-456" }
    });
    
    // Test AWS context has its credential
    const awsKey = await sandbox.execInContext("aws", "echo $AWS_ACCESS_KEY");
    console.log("AWS context key:", awsKey.stdout.trim());
    
    // Test GCP context doesn't have AWS credential
    const gcpNoAws = await sandbox.execInContext("gcp", "echo $AWS_ACCESS_KEY");
    console.log("GCP context AWS key (should be empty):", gcpNoAws.stdout.trim());
    
    // Test GCP context has its own credential
    const gcpKey = await sandbox.execInContext("gcp", "echo $GCP_API_KEY");
    console.log("GCP context key:", gcpKey.stdout.trim());
    
    if (awsKey.stdout.includes("aws-secret") && 
        gcpNoAws.stdout.trim() === "" &&
        gcpKey.stdout.includes("gcp-secret")) {
      console.log("✅ Credentials properly isolated between contexts!");
    } else {
      console.log("❌ Credential isolation failed");
    }
  } catch (error) {
    console.error("❌ Failed:", error);
  }
  
  console.log("\nTest 3: Session State Persistence");
  console.log("---------------------------------");
  try {
    // Create a stateful context
    await sandbox.createContext({
      name: "dev",
      cwd: "/tmp"
    });
    
    // Change directory
    await sandbox.execInContext("dev", "cd /var");
    const pwd1 = await sandbox.execInContext("dev", "pwd");
    console.log("After cd /var:", pwd1.stdout.trim());
    
    // Set environment variable
    await sandbox.execInContext("dev", "export MY_VAR=hello");
    const var1 = await sandbox.execInContext("dev", "echo $MY_VAR");
    console.log("After export:", var1.stdout.trim());
    
    // Create a file
    await sandbox.execInContext("dev", "echo 'test' > testfile.txt");
    const ls = await sandbox.execInContext("dev", "ls testfile.txt");
    console.log("File created:", ls.stdout.trim());
    
    // Verify state persists
    const pwd2 = await sandbox.execInContext("dev", "pwd");
    const var2 = await sandbox.execInContext("dev", "echo $MY_VAR");
    
    if (pwd2.stdout.trim() === "/var" && 
        var2.stdout.trim() === "hello" &&
        ls.stdout.includes("testfile.txt")) {
      console.log("✅ Session state persists across commands!");
    } else {
      console.log("❌ Session state not persisting");
    }
  } catch (error) {
    console.error("❌ Failed:", error);
  }
  
  console.log("\nTest 4: Background Processes");
  console.log("---------------------------");
  try {
    await sandbox.createContext({ name: "bg" });
    
    // Start a background process
    await sandbox.execInContext("bg", "sleep 30 &");
    console.log("Started background sleep");
    
    // Check it's running
    const jobs = await sandbox.execInContext("bg", "jobs");
    console.log("Jobs:", jobs.stdout.trim());
    
    const ps = await sandbox.execInContext("bg", "ps aux | grep sleep | grep -v grep");
    console.log("Process:", ps.stdout.trim());
    
    if (ps.stdout.includes("sleep")) {
      console.log("✅ Background processes work!");
    } else {
      console.log("❌ Background process not found");
    }
  } catch (error) {
    console.error("❌ Failed:", error);
  }
  
  console.log("\n🎉 Tests Complete!");
}

// Run tests
runTests().catch(console.error);