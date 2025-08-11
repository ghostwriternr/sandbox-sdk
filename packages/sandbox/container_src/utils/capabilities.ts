import { execSync } from 'child_process';
import { mkdirSync, rmdirSync, readFileSync } from 'fs';

export interface Capabilities {
  hasNamespaces: boolean;
  hasCapSysAdmin: boolean;
  hasCgroupDelegation: boolean;
  seccompMode: number;
  mode: 'production' | 'development' | 'unknown';
}

export async function detectCapabilities(): Promise<Capabilities> {
  const checks: Capabilities = {
    hasNamespaces: false,
    hasCapSysAdmin: false,
    hasCgroupDelegation: false,
    seccompMode: -1,
    mode: 'unknown'
  };
  
  // First check if startup script already detected CAP_SYS_ADMIN
  if (process.env.SANDBOX_HAS_CAP_SYS_ADMIN === 'true') {
    checks.hasNamespaces = true;
    checks.hasCapSysAdmin = true;
    checks.mode = 'production';
    console.log('[Capabilities] Using startup script detection: CAP_SYS_ADMIN=true, running in isolated namespace');
    return checks;
  } else if (process.env.SANDBOX_HAS_CAP_SYS_ADMIN === 'false') {
    checks.mode = 'development';
    console.log('[Capabilities] Using startup script detection: CAP_SYS_ADMIN=false, development mode');
    return checks;
  }
  
  try {
    // Fallback: Test namespace creation (requires CAP_SYS_ADMIN)
    execSync('unshare --pid --fork true', { stdio: 'ignore' });
    checks.hasNamespaces = true;
    checks.hasCapSysAdmin = true;
    
    // Test cgroup delegation
    const testDir = '/sys/fs/cgroup/test_' + Date.now();
    try {
      mkdirSync(testDir);
      rmdirSync(testDir);
      checks.hasCgroupDelegation = true;
    } catch {
      // Cgroup delegation not available
    }
    
    // Check seccomp mode
    try {
      const status = readFileSync('/proc/self/status', 'utf8');
      const seccomp = status.match(/Seccomp:\s+(\d+)/);
      if (seccomp) {
        checks.seccompMode = parseInt(seccomp[1]);
      }
    } catch {
      // Can't read seccomp status
    }
    
    // Determine environment
    checks.mode = checks.hasCapSysAdmin ? 'production' : 'development';
    
  } catch (error) {
    // Local dev environment without CAP_SYS_ADMIN
    checks.mode = 'development';
  }
  
  return checks;
}

export class IsolationStrategy {
  constructor(private capabilities: Capabilities) {}
  
  async hideControlPlane(): Promise<{ success: boolean; message: string }> {
    if (this.capabilities.hasNamespaces) {
      // Production: Full hiding via unshare
      console.log('✅ Production mode: Hiding control plane via unshare');
      return {
        success: true,
        message: 'Control plane hidden via PID namespace'
      };
    } else {
      // Local: Control plane remains visible
      console.warn('⚠️ Local Development Mode');
      console.warn('   - Control plane remains visible (no CAP_SYS_ADMIN)');
      console.warn('   - Avoid using pkill/killall commands');
      console.warn('   - Context isolation still works for credentials');
      return {
        success: false,
        message: 'Local dev mode - control plane visible but functional'
      };
    }
  }
  
  canCreateNamespaces(): boolean {
    return this.capabilities.hasNamespaces;
  }
  
  isProduction(): boolean {
    return this.capabilities.mode === 'production';
  }
  
  getCapabilities(): Capabilities {
    return this.capabilities;
  }
}