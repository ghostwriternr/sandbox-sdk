/**
 * Types for security context management (credential isolation)
 */

export interface SecurityContextOptions {
  name: string;
  env?: Record<string, string>;
  cwd?: string;
  persistent?: boolean;
  isolation?: 'none' | 'secure';
  childContext?: string;
}

export interface SecurityContextResponse {
  success: boolean;
  context: {
    name: string;
    hasChildRouting: boolean;
    isolation: string;
  };
}

export interface SecurityContextExecRequest {
  context: string;
  command: string;
  options?: {
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
  };
}

export interface SecurityContextExecResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SecurityContextListResponse {
  contexts: string[];
  count: number;
}

export interface SecurityContextExistsResponse {
  exists: boolean;
  context: string;
}

export interface SecurityContext {
  name: string;
  exec(command: string, options?: SecurityContextExecOptions): Promise<SecurityContextExecResult>;
  cd(path: string): Promise<SecurityContextExecResult>;
  pwd(): Promise<string>;
  setEnv(vars: Record<string, string>): Promise<void>;
}

export interface SecurityContextExecOptions {
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

export interface SecurityContextExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  command: string;
  duration: number;
  timestamp: string;
}

export interface SecurityErrorResponse {
  error: string;
  message?: string;
  details?: string;
}