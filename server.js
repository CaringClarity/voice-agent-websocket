/**
 * WebSocket Server for Twilio Media Streams - SIMPLIFIED ECHO TEST
 * This version has NO database dependencies and simply echoes back any received audio.
 */
const WebSocket = require("ws");
const { Buffer } = require("buffer");

// Store active sessions
const sessions = {};

// WebSocket server setup
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

console.log(`🚀 ECHO TEST: WebSocket server started on port ${process.env.PORT || 8080}`);

wss.on("connection", (ws, req) => {
  console.log("🔌 New WebSocket connection established");

  // Extract query parameters
  const urlParams = new URLSearchParams(req.url.split("?")[1] || "");
  const callSid = urlParams.get("callSid") || "unknown-call";
  
  console.log(`🔗 Connection established for callSid: ${callSid}`);

  // Initialize session state
  const session = {
    ws,
    callSid,
    streamSid: null,
    inboundChunkCounter: 0,
    outboundChunkCounter: 0
  };
  sessions[callSid] = session;

  ws.on("message", async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.event) {
        case "connected":
          console.log("🔗 Twilio WebSocket connected event received");
          break;

        case "start":
          console.log("🚀 Twilio stream started event received");
          session.streamSid = msg.start.streamSid;
          console.log(`🔊 Stream SID set: ${session.streamSid}`);
          break;

        case "media":
          // ECHO TEST: Immediately send back the received audio
          if (msg.media && msg.media.payload && msg.media.track === "inbound") {
            session.inboundChunkCounter++;
            
            // Decode the incoming payload
            const inboundAudioBuffer = Buffer.from(msg.media.payload, "base64");
            console.log(`🎤 Received audio chunk #${session.inboundChunkCounter}, size: ${inboundAudioBuffer.length} bytes`);
            
            // Send the received audio back to Twilio (echo)
            await sendAudioToTwilio(session, inboundAudioBuffer);
          }
          break;

        case "stop":
          console.log("🛑 Twilio stream stopped event received");
          cleanupSession(callSid);
          break;

        case "mark":
          console.log(`🏷️ Received mark event: ${msg.mark?.name || "unnamed"}`);
          break;

        default:
          console.log(`❓ Received unknown event type: ${msg.event}`);
          break;
      }
    } catch (error) {
      console.error("💥 Error processing WebSocket message:", error);
    }
  });

  ws.on("error", (error) => {
    console.error("💥 WebSocket error:", error);
    cleanupSession(callSid);
  });

  ws.on("close", (code, reason) => {
    console.log(`🚪 WebSocket connection closed: ${code} ${reason}`);
    cleanupSession(callSid);
  });
});

/**
 * Send audio back to Twilio (Echo Function)
 * @param {Object} session - The session object
 * @param {Buffer} audioBuffer - The audio buffer to send
 * @returns {Promise<boolean>} - True if successful
 */
async function sendAudioToTwilio(session, audioBuffer) {
  try {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      console.error("❌ WebSocket not open, cannot send audio to Twilio");
      return false;
    }
    
    if (!session.streamSid) {
      console.error("❌ Stream SID not set, cannot send audio");
      return false;
    }
    
    if (!audioBuffer || audioBuffer.length === 0) {
      console.error("❌ Empty audio buffer, nothing to send to Twilio");
      return false;
    }

    // Use 320 bytes chunk size (40ms of 8kHz mulaw audio)
    const CHUNK_SIZE = 320;
    const completeChunks = Math.floor(audioBuffer.length / CHUNK_SIZE);
    const remainingBytes = audioBuffer.length % CHUNK_SIZE;

    console.log(`📊 Audio chunking: ${completeChunks} complete chunks, ${remainingBytes} remaining bytes`);

    // Process complete chunks
    for (let i = 0; i < completeChunks; i++) {
      session.outboundChunkCounter++;
      const chunk = audioBuffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      
      const mediaMessage = {
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: chunk.toString("base64"),
          track: "outbound",
          timestamp: Date.now(),
          chunk: session.outboundChunkCounter, // 1-based chunk indexing
          streamSid: session.streamSid
        }
      };
      
      session.ws.send(JSON.stringify(mediaMessage));
      await new Promise(resolve => setTimeout(resolve, 40)); // Wait 40ms between chunks
    }

    // Handle remaining bytes with proper padding
    if (remainingBytes > 0) {
      session.outboundChunkCounter++;
      const paddedChunk = Buffer.alloc(CHUNK_SIZE, 0xFF); // Pad with 0xFF (mulaw silence)
      audioBuffer.copy(paddedChunk, 0, completeChunks * CHUNK_SIZE);
      
      console.log(`🔍 Padded final chunk: ${remainingBytes} bytes + ${CHUNK_SIZE - remainingBytes} bytes padding`);
      
      const mediaMessage = {
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: paddedChunk.toString("base64"),
          track: "outbound",
          timestamp: Date.now(),
          chunk: session.outboundChunkCounter,
          streamSid: session.streamSid
        }
      };
      
      session.ws.send(JSON.stringify(mediaMessage));
    }

    console.log(`✅ Sent ${completeChunks + (remainingBytes > 0 ? 1 : 0)} chunks to Twilio`);
    return true;
  } catch (error) {
    console.error("❌ Error sending audio to Twilio:", error);
    return false;
  }
}

// Cleanup function
function cleanupSession(callSid) {
  if (sessions[callSid]) {
    console.log(`🧹 Cleaning up session for callSid: ${callSid}`);
    const session = sessions[callSid];
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try {
        session.ws.close(1000, "Session cleanup");
      } catch (e) {
        console.error("Error closing WebSocket during cleanup:", e);
      }
    }
    delete sessions[callSid];
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🔌 Shutting down WebSocket server...");
  wss.close(() => {
    console.log("✅ WebSocket server closed.");
    process.exit(0);
  });
});

console.log("🔊 ECHO TEST SERVER READY - Will echo back any received audio");
