#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>

// Function pointers to real implementations
static int (*real_execve)(const char*, char *const[], char *const[]) = NULL;
static int (*real_execvp)(const char*, char *const[]) = NULL;
static int (*real_execl)(const char*, const char*, ...) = NULL;
static int (*real_execlp)(const char*, const char*, ...) = NULL;
static int (*real_system)(const char*) = NULL;
static FILE* (*real_popen)(const char*, const char*) = NULL;

// Initialize function pointers
__attribute__((constructor)) void init() {
    real_execve = dlsym(RTLD_NEXT, "execve");
    real_execvp = dlsym(RTLD_NEXT, "execvp");
    real_execl = dlsym(RTLD_NEXT, "execl");
    real_execlp = dlsym(RTLD_NEXT, "execlp");
    real_system = dlsym(RTLD_NEXT, "system");
    real_popen = dlsym(RTLD_NEXT, "popen");
}

// Helper to check if we should route to a different context
static int should_route() {
    return getenv("SANDBOX_ROUTE_TO_CONTEXT") != NULL;
}

// Helper to execute in target context
static int route_to_context(const char *pathname, char *const argv[], char *const envp[]) {
    const char* target = getenv("SANDBOX_ROUTE_TO_CONTEXT");
    if (!target) {
        return real_execve(pathname, argv, envp);
    }
    
    // Try to connect to routing daemon
    int sock = socket(AF_UNIX, SOCK_STREAM, 0);
    if (sock < 0) {
        // Fallback to direct execution if daemon not available
        return real_execve(pathname, argv, envp);
    }
    
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, "/tmp/sandbox_router.sock", sizeof(addr.sun_path)-1);
    
    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        close(sock);
        // Fallback to direct execution if daemon not reachable
        return real_execve(pathname, argv, envp);
    }
    
    // Send routing request
    dprintf(sock, "ROUTE\n");
    dprintf(sock, "CONTEXT:%s\n", target);
    dprintf(sock, "CMD:%s\n", pathname);
    
    // Send arguments
    if (argv) {
        for (int i = 0; argv[i]; i++) {
            dprintf(sock, "ARG:%s\n", argv[i]);
        }
    }
    
    // Send environment variables (filtered)
    if (envp) {
        for (int i = 0; envp[i]; i++) {
            // Skip routing-specific env vars to prevent infinite recursion
            if (strncmp(envp[i], "SANDBOX_ROUTE_TO_CONTEXT=", 26) != 0 &&
                strncmp(envp[i], "LD_PRELOAD=", 11) != 0) {
                dprintf(sock, "ENV:%s\n", envp[i]);
            }
        }
    }
    
    dprintf(sock, "END\n");
    
    // Wait for response
    char result[32];
    int n = read(sock, result, sizeof(result)-1);
    close(sock);
    
    if (n > 0) {
        result[n] = '\0';
        int exit_code = atoi(result);
        exit(exit_code);
    }
    
    // Fallback to direct execution
    return real_execve(pathname, argv, envp);
}

// Intercepted functions
int execve(const char *pathname, char *const argv[], char *const envp[]) {
    if (should_route()) {
        return route_to_context(pathname, argv, envp);
    }
    return real_execve(pathname, argv, envp);
}

int execvp(const char *file, char *const argv[]) {
    if (should_route()) {
        // Convert to execve for routing
        char *path = getenv("PATH");
        if (!path) path = "/usr/bin:/bin";
        
        // Try to find the file in PATH
        char fullpath[4096];
        char *path_copy = strdup(path);
        char *dir = strtok(path_copy, ":");
        
        while (dir) {
            snprintf(fullpath, sizeof(fullpath), "%s/%s", dir, file);
            if (access(fullpath, X_OK) == 0) {
                free(path_copy);
                return route_to_context(fullpath, argv, environ);
            }
            dir = strtok(NULL, ":");
        }
        free(path_copy);
        
        // Not found in PATH, try direct
        return route_to_context(file, argv, environ);
    }
    return real_execvp(file, argv);
}

int system(const char *command) {
    if (should_route()) {
        // Route via execve
        char *argv[] = {"sh", "-c", (char*)command, NULL};
        return route_to_context("/bin/sh", argv, environ);
    }
    return real_system(command);
}

FILE *popen(const char *command, const char *type) {
    if (should_route()) {
        // For popen, we need to handle it differently
        // This is complex, so for now just use real popen with filtered env
        char *filtered_env[1024];
        int j = 0;
        
        for (int i = 0; environ[i] && j < 1023; i++) {
            // Remove routing env vars to prevent recursion
            if (strncmp(environ[i], "SANDBOX_ROUTE_TO_CONTEXT=", 26) != 0 &&
                strncmp(environ[i], "LD_PRELOAD=", 11) != 0) {
                filtered_env[j++] = environ[i];
            }
        }
        filtered_env[j] = NULL;
        
        // Temporarily replace environ
        char **old_environ = environ;
        environ = filtered_env;
        FILE *result = real_popen(command, type);
        environ = old_environ;
        
        return result;
    }
    return real_popen(command, type);
}