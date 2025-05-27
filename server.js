/**
 * Integration script for Next.js custom server with WebSocket support
 * This file should be used instead of the default Next.js server
 * when deploying to environments that support custom servers
 */
const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const { initWebSocketServer } = require('./lib/services/streamingService')
const { logInfo, logError } = require('./lib/services/loggingService')

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

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

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true)
    handle(req, res, parsedUrl)
  })
  
  // Initialize WebSocket server with the HTTP server
  try {
    initWebSocketServer(server)
    logInfo("Server", "WebSocket server initialized successfully")
  } catch (error) {
    logError("Server", "Failed to initialize WebSocket server", { error: error.message })
  }
  
  const PORT = process.env.PORT || 3000
  server.listen(PORT, (err) => {
    if (err) throw err
    console.log(`> Ready on http://localhost:${PORT}`)
    logInfo("Server", `Server started on port ${PORT}`)
  })
})
