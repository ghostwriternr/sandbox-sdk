import { ContextManager } from '../api/context';
import { ContextOptions, ExecOptions } from '../utils/context';

// Response types
interface SecurityContextResponse {
  success: boolean;
  context: {
    name: string;
    hasChildRouting: boolean;
    isolation: string;
  };
}

interface SecurityContextExecResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SecurityContextListResponse {
  contexts: string[];
  count: number;
}

interface SecurityContextExistsResponse {
  exists: boolean;
  context: string;
}

interface ErrorResponse {
  error: string;
}

// Handle security context creation
export async function handleCreateSecurityContext(
  contextManager: ContextManager,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await req.json() as ContextOptions;
    
    // Validate required fields
    if (!body.name) {
      return new Response(
        JSON.stringify({ error: "Context name is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }
    
    // Create the context
    const context = await contextManager.createContext(body);
    
    const response: SecurityContextResponse = {
      success: true,
      context: {
        name: context.getName(),
        hasChildRouting: !!body.childContext,
        isolation: body.isolation || 'secure'
      }
    };
    
    return new Response(
      JSON.stringify(response),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error: any) {
    const errorResponse: ErrorResponse = {
      error: error.message || "Failed to create security context"
    };
    
    return new Response(
      JSON.stringify(errorResponse),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}

// Handle execution in security context
export async function handleExecInContext(
  contextManager: ContextManager,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const body = await req.json() as {
      context: string;
      command: string;
      options?: ExecOptions;
    };
    
    // Validate required fields
    if (!body.context || !body.command) {
      return new Response(
        JSON.stringify({ error: "Context name and command are required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }
    
    // Execute in context
    console.log(`[SecurityContext] Executing in context '${body.context}': ${body.command}`);
    const result = await contextManager.execInContext(
      body.context,
      body.command,
      body.options
    );
    console.log(`[SecurityContext] Result: stdout='${result.stdout}', exitCode=${result.exitCode}`);
    
    const response: SecurityContextExecResponse = {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
    
    return new Response(
      JSON.stringify(response),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to execute in context"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}

// Handle listing security contexts
export async function handleListSecurityContexts(
  contextManager: ContextManager,
  req: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const contexts = contextManager.listContexts();
    
    const response: SecurityContextListResponse = {
      contexts: contexts,
      count: contexts.length
    };
    
    return new Response(
      JSON.stringify(response),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to list contexts"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}

// Handle checking if context exists
export async function handleHasSecurityContext(
  contextManager: ContextManager,
  contextName: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const exists = contextManager.hasContext(contextName);
    
    const response: SecurityContextExistsResponse = {
      exists: exists,
      context: contextName
    };
    
    return new Response(
      JSON.stringify(response),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to check context"
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      }
    );
  }
}