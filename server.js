/**
 * Standalone Express server for WebSocket handling on Render
 * Optimized version without Next.js dependencies
 */
const express = require('express');
const http = require('http');
const { initWebSocketServer } = require('./lib/services/streamingService');
const { logInfo, logError } = require('./lib/services/loggingService');

// Check required environment variables
const requiredEnvVars = [
  'DEEPGRAM_API_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GROQ_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
  }
}

const app = express();
const server = http.createServer(app);

// Initialize WebSocket server with the HTTP server
try {
  initWebSocketServer(server);
  logInfo("Server", "WebSocket server initialized successfully");
} catch (error) {
  logError("Server", "Failed to initialize WebSocket server", { error: error.message });
}

// Add health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Add environment variables check endpoint
app.get('/health/env', (req, res) => {
  // Check required environment variables
  const envStatus = {
    DEEPGRAM_API_KEY: !!process.env.DEEPGRAM_API_KEY,
    NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
  };
  
  const missingVars = Object.entries(envStatus)
    .filter(([_, value]) => !value)
    .map(([key]) => key);
  
  if (missingVars.length > 0) {
    return res.json({
      status: "warning",
      message: "Some environment variables are missing",
      missingVars,
      timestamp: new Date().toISOString(),
    });
  }
  
  return res.json({
    status: "healthy",
    message: "All required environment variables are set",
    timestamp: new Date().toISOString(),
  });
});

// Add debug endpoint for WebSocket testing
app.get('/debug', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WebSocket Debug</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        #status { padding: 10px; border-radius: 5px; margin: 20px 0; }
        .connected { background-color: #d4edda; color: #155724; }
        .disconnected { background-color: #f8d7da; color: #721c24; }
        .connecting { background-color: #fff3cd; color: #856404; }
        pre { background-color: #f8f9fa; padding: 10px; border-radius: 5px; overflow: auto; }
        button { padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background-color: #0069d9; }
      </style>
    </head>
    <body>
      <h1>WebSocket Connection Test</h1>
      <div id="status" class="connecting">Connecting...</div>
      <button id="reconnect">Reconnect</button>
      <h2>Connection Log</h2>
      <pre id="log"></pre>
      
      <script>
        const statusEl = document.getElementById('status');
        const logEl = document.getElementById('log');
        const reconnectBtn = document.getElementById('reconnect');
        let ws;
        
        function log(message) {
          const timestamp = new Date().toISOString();
          logEl.textContent = \`[\${timestamp}] \${message}\\n\` + logEl.textContent;
        }
        
        function connect() {
          statusEl.textContent = 'Connecting...';
          statusEl.className = 'connecting';
          
          // Create a test session ID
          const sessionId = 'test-session-' + Date.now();
          const callSid = 'test-call-' + Date.now();
          
          // Connect to the WebSocket server
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = \`\${protocol}//\${window.location.host}/stream?callSid=\${callSid}&tenantId=test&userId=test\`;
          log(\`Connecting to \${wsUrl}\`);
          
          ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            statusEl.textContent = 'Connected!';
            statusEl.className = 'connected';
            log('Connection established');
            
            // Send a test start event
            const startEvent = {
              event: 'start',
              start: {
                callSid: callSid,
                streamSid: 'test-stream-' + Date.now()
              }
            };
            
            ws.send(JSON.stringify(startEvent));
            log('Sent start event: ' + JSON.stringify(startEvent));
          };
          
          ws.onclose = (event) => {
            statusEl.textContent = \`Disconnected (code: \${event.code})\`;
            statusEl.className = 'disconnected';
            log(\`Connection closed: code=\${event.code}, reason=\${event.reason}\`);
          };
          
          ws.onerror = (error) => {
            statusEl.textContent = 'Error';
            statusEl.className = 'disconnected';
            log('Connection error');
          };
          
          ws.onmessage = (event) => {
            log('Received: ' + event.data);
          };
        }
        
        reconnectBtn.addEventListener('click', () => {
          if (ws) {
            ws.close();
          }
          connect();
        });
        
        // Initial connection
        connect();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/stream`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Debug page: http://localhost:${PORT}/debug`);
  
  logInfo("Server", `Server started on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
