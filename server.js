/**
 * WebSocket Server for Twilio Media Streams - ECHO TEST
 * Optimized for 320-byte chunks and proper Twilio audio format
 * FIXED VERSION - Improved for Twilio Schema Compliance
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Track active connections
const connections = new Map();

// Buffer to store incoming audio chunks for combining
const audioBuffers = new Map();

// Sequence counters for outgoing audio
const sequenceCounters = new Map();

// Root route
app.get('/', (req, res) => {
  res.send('Twilio Media Stream Echo Server - Running');
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  // Generate unique connection ID
  const connectionId = uuidv4();
  
  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid') || 'unknown';
  
  console.log(`🔌 WebSocket connection established (ID: ${connectionId}, Call SID: ${callSid})`);
  
  // Store connection
  connections.set(connectionId, {
    ws,
    callSid,
    connected: true,
    lastActivity: Date.now()
  });
  
  // Initialize audio buffer for this connection
  audioBuffers.set(connectionId, Buffer.alloc(0));
  
  // Initialize sequence counter (starting from 1 for Twilio)
  sequenceCounters.set(connectionId, 1);
  
  // Send connected acknowledgment
  ws.send(JSON.stringify({
    event: 'connected'
  }));
  
  // Message handler
  ws.on('message', async (message) => {
    try {
      // Parse message
      const msg = JSON.parse(message);
      
      // Handle different message types
      switch (msg.event) {
        case 'connected':
          console.log(`✅ Twilio connected event received for call ${callSid}`);
          break;
          
        case 'start':
          console.log(`🎬 Media stream started for call ${callSid}`);
          console.log(`📊 Stream parameters: ${JSON.stringify(msg.start)}`);
          break;
          
        case 'media':
          // Process incoming audio
          if (msg.media && msg.media.payload) {
            // Decode base64 audio
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            
            // Log audio details for debugging
            if (sequenceCounters.get(connectionId) <= 2) {
              console.log(`🔍 Audio format check: ${audioBuffer.length} bytes, first 10 bytes:`, 
                          audioBuffer.slice(0, 10));
            }
            
            console.log(`🎤 Received audio chunk #${msg.media.chunk}, size: ${audioBuffer.length} bytes`);
            
            // Get current buffer for this connection
            let currentBuffer = audioBuffers.get(connectionId);
            
            // Append new audio to buffer
            currentBuffer = Buffer.concat([currentBuffer, audioBuffer]);
            
            // Check if we have enough data for a 320-byte chunk
            if (currentBuffer.length >= 320) {
              // Extract 320 bytes
              const chunkToSend = currentBuffer.slice(0, 320);
              
              // Keep remaining bytes for next time
              audioBuffers.set(connectionId, currentBuffer.slice(320));
              
              // Echo the audio back to Twilio
              await echoAudioToTwilio(ws, callSid, chunkToSend, sequenceCounters.get(connectionId));
              
              // Increment sequence counter
              sequenceCounters.set(connectionId, sequenceCounters.get(connectionId) + 1);
            } else {
              // Not enough data yet, save for next chunk
              audioBuffers.set(connectionId, currentBuffer);
              console.log(`📦 Buffering audio: ${currentBuffer.length}/320 bytes collected`);
            }
          }
          break;
          
        case 'stop':
          console.log(`🛑 Media stream stopped for call ${callSid}`);
          break;
          
        default:
          console.log(`📨 Received event: ${msg.event}`);
          break;
      }
    } catch (error) {
      console.error(`❌ Error processing message: ${error.message}`);
    }
  });
  
  // Connection close handler
  ws.on('close', () => {
    console.log(`🔌 WebSocket connection closed (ID: ${connectionId})`);
    connections.delete(connectionId);
    audioBuffers.delete(connectionId);
    sequenceCounters.delete(connectionId);
  });
  
  // Connection error handler
  ws.on('error', (error) => {
    console.error(`❌ WebSocket error (ID: ${connectionId}): ${error.message}`);
    connections.delete(connectionId);
    audioBuffers.delete(connectionId);
    sequenceCounters.delete(connectionId);
  });
});

/**
 * Echo audio back to Twilio with proper formatting
 * @param {WebSocket} ws - WebSocket connection
 * @param {string} streamSid - Stream SID
 * @param {Buffer} audioBuffer - Audio buffer to send
 * @param {number} sequenceNumber - Sequence number for this chunk
 * @returns {Promise<void>}
 */
async function echoAudioToTwilio(ws, streamSid, audioBuffer, sequenceNumber) {
  try {
    // Ensure we have exactly 320 bytes (40ms of 8kHz mulaw audio)
    let finalBuffer = audioBuffer;
    let paddingSize = 0;
    
    // If buffer is smaller than 320 bytes, pad with 0xFF (mulaw silence)
    if (audioBuffer.length < 320) {
      paddingSize = 320 - audioBuffer.length;
      const padding = Buffer.alloc(paddingSize, 0xFF);
      finalBuffer = Buffer.concat([audioBuffer, padding]);
      console.log(`🔍 Padded audio chunk: ${audioBuffer.length} bytes + ${padding.length} bytes padding`);
    }
    
    // Convert to base64
    const payload = finalBuffer.toString('base64');
    
    // Create media message with proper format for Twilio
    const mediaMessage = {
      event: 'media',
      streamSid: streamSid,
      media: {
        track: 'outbound',
        chunk: sequenceNumber,
        timestamp: Date.now(),
        payload: payload
      }
    };
    
    // Send to Twilio
    ws.send(JSON.stringify(mediaMessage));
    
    console.log(`✅ Sent audio chunk #${sequenceNumber} (${audioBuffer.length + paddingSize} bytes) to Twilio`);
    
    // Add a small delay to match audio timing (40ms per chunk)
    await new Promise(resolve => setTimeout(resolve, 40));
    
  } catch (error) {
    console.error(`❌ Error sending audio to Twilio: ${error.message}`);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Echo Test Server running on port ${PORT}`);
  console.log(`📝 Configured for 320-byte chunks (40ms of 8kHz mulaw audio)`);
  console.log(`🔧 Using 1-based chunk indexing as required by Twilio`);
});

// Periodic cleanup of stale connections
setInterval(() => {
  const now = Date.now();
  connections.forEach((connection, id) => {
    if (now - connection.lastActivity > 300000) { // 5 minutes
      console.log(`🧹 Cleaning up stale connection: ${id}`);
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close();
      }
      connections.delete(id);
      audioBuffers.delete(id);
      sequenceCounters.delete(id);
    }
  });
}, 60000); // Check every minute
