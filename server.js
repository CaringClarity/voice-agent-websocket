/**
 * WebSocket Server for Twilio Media Streams - ECHO TEST VERSION
 * This version bypasses Deepgram STT/TTS and AI processing to test the audio pathway.
 * It simply echoes back any received audio from Twilio.
 */
const WebSocket = require("ws")
const { createClient } = require("@supabase/supabase-js")
const { Buffer } = require("buffer")

// Initialize Supabase client
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Store active sessions
const sessions = {}

// WebSocket server setup
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 })

console.log(`🚀 WebSocket server started on port ${process.env.PORT || 8080}`)

wss.on("connection", (ws, req) => {
  console.log("🔌 New WebSocket connection established")

  // Extract query parameters
  const urlParams = new URLSearchParams(req.url.split("?")[1])
  const callSid = urlParams.get("callSid")
  const tenantId = urlParams.get("tenantId")
  const userId = urlParams.get("userId")

  if (!callSid || !tenantId) {
    console.error("❌ Missing callSid or tenantId in WebSocket URL")
    ws.close(1008, "Missing required parameters")
    return
  }

  console.log(`🔗 Connection details: callSid=${callSid}, tenantId=${tenantId}, userId=${userId}`)

  // Initialize session state
  const session = {
    ws,
    callSid,
    tenantId,
    userId,
    streamSid: null,
    inboundChunkCounter: 0,
    outboundChunkCounter: 0,
    // Add any other necessary session state here
  }
  sessions[callSid] = session

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message)

      switch (msg.event) {
        case "connected":
          console.log("🔗 Twilio WebSocket connected event received")
          break

        case "start":
          console.log("🚀 Twilio stream started event received")
          session.streamSid = msg.start.streamSid
          console.log(`🔊 Stream SID set: ${session.streamSid}`)
          // You could potentially send an initial silent chunk or mark here if needed
          break

        case "media":
          // ECHO TEST: Immediately send back the received audio
          if (msg.media && msg.media.payload && msg.media.track === "inbound") {
            session.inboundChunkCounter++
            // console.log(`🎤 Received inbound audio chunk #${session.inboundChunkCounter}, payload size: ${msg.media.payload.length}`);

            // Decode the incoming payload
            const inboundAudioBuffer = Buffer.from(msg.media.payload, "base64")

            // Send the received audio back to Twilio (echo)
            await sendAudioToTwilio(session, inboundAudioBuffer)
          } else {
            // console.log("Received non-inbound media or empty payload, ignoring for echo test.");
          }
          break

        case "stop":
          console.log("🛑 Twilio stream stopped event received")
          cleanupSession(callSid)
          break

        case "mark":
          // console.log(`🏷️ Received mark event: ${msg.mark.name}`);
          // Handle mark events if needed (e.g., acknowledge completion)
          break

        default:
          console.log(`❓ Received unknown event type: ${msg.event}`) // Log unknown events
          break
      }
    } catch (error) {
      console.error("💥 Error processing WebSocket message:", error)
    }
  })

  ws.on("error", (error) => {
    console.error("💥 WebSocket error:", error)
    cleanupSession(callSid)
  })

  ws.on("close", (code, reason) => {
    console.log(`🚪 WebSocket connection closed: ${code} ${reason}`)
    cleanupSession(callSid)
  })
})

/**
 * Send audio back to Twilio (Echo Function)
 * This function takes the received audio buffer and sends it back,
 * applying the necessary chunking, padding, and timing.
 * @param {Object} session - The session object
 * @param {Buffer} audioBuffer - The audio buffer to send (received from Twilio)
 * @returns {Promise<boolean>} - True if successful
 */
async function sendAudioToTwilio(session, audioBuffer) {
  try {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      // console.error("❌ WebSocket not open, cannot send audio to Twilio");
      return false
    }
    if (!session.streamSid) {
      // console.error("❌ Stream SID not set, cannot send audio");
      return false
    }
    if (!audioBuffer || audioBuffer.length === 0) {
      // console.error("❌ Empty audio buffer, nothing to send to Twilio");
      return false
    }

    // Use 320 bytes chunk size (40ms of 8kHz mulaw audio)
    const CHUNK_SIZE = 320
    const completeChunks = Math.floor(audioBuffer.length / CHUNK_SIZE)
    const remainingBytes = audioBuffer.length % CHUNK_SIZE

    // Process complete chunks
    for (let i = 0; i < completeChunks; i++) {
      session.outboundChunkCounter++
      const chunk = audioBuffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
      const mediaMessage = {
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: chunk.toString("base64"),
          track: "outbound",
          timestamp: Date.now(), // Use current timestamp
          chunk: session.outboundChunkCounter, // Use session counter for sequence
          streamSid: session.streamSid,
        },
      }
      session.ws.send(JSON.stringify(mediaMessage))
      await new Promise((resolve) => setTimeout(resolve, 40)) // Wait 40ms
    }

    // Handle remaining bytes with proper padding
    if (remainingBytes > 0) {
      session.outboundChunkCounter++
      const paddedChunk = Buffer.alloc(CHUNK_SIZE, 0xff) // Pad with 0xFF (mulaw silence)
      audioBuffer.copy(paddedChunk, 0, completeChunks * CHUNK_SIZE)
      const mediaMessage = {
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: paddedChunk.toString("base64"),
          track: "outbound",
          timestamp: Date.now(), // Use current timestamp
          chunk: session.outboundChunkCounter, // Use session counter for sequence
          streamSid: session.streamSid,
        },
      }
      session.ws.send(JSON.stringify(mediaMessage))
      await new Promise((resolve) => setTimeout(resolve, 40)) // Wait 40ms after last chunk too
    }

    // console.log(`📢 Echoed back ${completeChunks + (remainingBytes > 0 ? 1 : 0)} chunks`);
    return true
  } catch (error) {
    console.error("❌ Error sending echo audio to Twilio:", error)
    return false
  }
}

// Cleanup function
function cleanupSession(callSid) {
  if (sessions[callSid]) {
    console.log(`🧹 Cleaning up session for callSid: ${callSid}`)
    const session = sessions[callSid]
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.close(1000, "Session cleanup")
      } catch (e) {
        console.error("Error closing WebSocket during cleanup:", e)
      }
    }
    // Add any other cleanup logic here (e.g., close Deepgram connection if used)
    delete sessions[callSid]
  } else {
    // console.log(`Session already cleaned up or not found for callSid: ${callSid}`);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🔌 Shutting down WebSocket server...")
  wss.close(() => {
    console.log("✅ WebSocket server closed.")
    process.exit(0)
  })
})

