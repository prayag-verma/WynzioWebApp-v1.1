/**
 * WebRTC Viewer for Wynzio
 * Handles screen viewing and remote control functionality
 * Updated to exactly match Windows app WebRTCService.cs expectations
 */
const WynzioWebRTC = (function() {
  // Private variables
  let socket = null;
  let peerConnection = null;
  let remotePcId = null;
  let clientId = null;
  let isConnected = false;
  let isConnecting = false;
  let viewerElement = null;
  let streamElement = null;
  let controlsEnabled = false;
  let connectionCallbacks = {};
  let dataChannel = null;
  let reconnectAttempts = 0;
  let reconnectTimeout = null;
  let connectionMonitorInterval = null;
  let preferredCodecs = ['VP8']; // Match Windows app VideoCodecsEnum.VP8 restriction
  
  // Reconnection configuration - matches Windows app settings
  const MAX_RECONNECT_ATTEMPTS = 5;  // Match Windows app MaxReconnectAttempts
  const RECONNECT_BASE_DELAY = 30000; // 30 seconds to match Windows app ConnectionSettings.cs _reconnectInterval
  
  // Configuration - matches Windows app settings in ConnectionSettings.cs
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ],
    sdpSemantics: 'unified-plan',
    iceCandidatePoolSize: 10
  };
  
  // Singleton instance
  let instance = null;
  
  /**
   * Get stored client ID from localStorage or generate a new one
   * Renamed to match Windows app convention
   * @returns {string} Client ID
   */
  function getStoredClientId() {
    // First try with new name format
    let storedClientId = localStorage.getItem('webClientId');
    
    // If not found, try legacy format for backward compatibility
    if (!storedClientId) {
      storedClientId = localStorage.getItem('wynzio_client_id');
      // If found in old format, migrate to new format
      if (storedClientId) {
        localStorage.setItem('webClientId', storedClientId);
        // Keep old key for backward compatibility but future updates will use new key
      }
    }
    
    // If still not found, generate new ID
    if (!storedClientId) {
      storedClientId = 'web-client-' + Date.now();
      localStorage.setItem('webClientId', storedClientId);
      console.log('Created new client ID:', storedClientId);
    } else {
      console.log('Using stored client ID:', storedClientId);
    }
    
    return storedClientId;
  }
  
  /**
   * Store and retrieve session data for reuse
   * Added to match Windows app SessionManager.cs
   */
  function storeSessionId(sid, timestamp = Date.now()) {
    try {
      const sessionData = {
        Sid: sid,
        Timestamp: timestamp
      };
      localStorage.setItem('wynzio_session_id', JSON.stringify(sessionData));
      localStorage.setItem('wynzio_session_timestamp', timestamp.toString());
      console.log('Stored session ID:', sid);
    } catch (error) {
      console.error('Error storing session ID:', error);
    }
  }
  
  function getStoredSessionId() {
    try {
      // Try to load from serialized format first (matches Windows app)
      const sessionStr = localStorage.getItem('wynzio_session_id');
      if (!sessionStr) return null;
      
      let sessionData;
      try {
        // Try to parse as JSON (Windows app SessionManager.cs format)
        sessionData = JSON.parse(sessionStr);
        const timestamp = sessionData.Timestamp || parseInt(localStorage.getItem('wynzio_session_timestamp') || '0');
        
        // Check if session is still valid (less than 24 hours old) - matching Windows app
        if (sessionData.Sid && (Date.now() - timestamp < 24 * 60 * 60 * 1000)) {
          console.log('Using stored session ID:', sessionData.Sid);
          return sessionData.Sid;
        }
      } catch (e) {
        // Not a JSON object, might be just a string ID
        const timestamp = parseInt(localStorage.getItem('wynzio_session_timestamp') || '0');
        
        // Check if session is still valid (less than 24 hours old) - matching Windows app
        if (sessionStr && (Date.now() - timestamp < 24 * 60 * 60 * 1000)) {
          console.log('Using stored session ID (string format):', sessionStr);
          return sessionStr;
        }
      }
    } catch (error) {
      console.error('Error retrieving session ID:', error);
    }
    
    console.log('No valid session ID found');
    return null;
  }
  
  /**
   * Clear session data
   */
  function clearSessionData() {
    localStorage.removeItem('wynzio_session_id');
    localStorage.removeItem('wynzio_session_timestamp');
    console.log('Cleared session data');
  }
  
  /**
   * WebRTC Client Class
   */
  class WebRTCClient {
    /**
     * Initialize the WebRTC viewer
     * @param {Object} options - Configuration options
     */
    initialize(options = {}) {
      // Set configuration
      if (options.iceServers) {
        config.iceServers = options.iceServers;
      }
      
      // Set socket if provided
      if (options.socket) {
        socket = options.socket;
        this.setupSocketHandlers();
      }
      
      // Set view element
      if (options.viewerElement) {
        this.setViewerElement(options.viewerElement);
      }
      
      // Set device ID and generate client ID
      if (options.remotePcId) {
        remotePcId = options.remotePcId;
      }
      
      // Use the clientId from options if provided, or get from storage
      clientId = options.clientId || getStoredClientId();
      
      // Set connection callbacks
      connectionCallbacks = {
        onConnecting: options.onConnecting || function() {},
        onConnected: options.onConnected || function() {},
        onDisconnected: options.onDisconnected || function() {},
        onError: options.onError || function() {}
      };
      
      // Initialize controls state
      controlsEnabled = options.enableControls !== false;
      
      // Reset connection state
      isConnected = false;
      isConnecting = false;
      reconnectAttempts = 0;
      
      // Set preferred codecs - matching Windows app VideoEncoderEndPoint settings
      if (options.preferredCodecs) {
        preferredCodecs = options.preferredCodecs;
      }
      
      // Start connection monitoring
      this.startConnectionMonitoring();
      
      return {
        connect: this.connect.bind(this),
        disconnect: this.disconnect.bind(this),
        isConnected: () => isConnected,
        isConnecting: () => isConnecting,
        enableControls: this.enableControls.bind(this),
        disableControls: this.disableControls.bind(this),
        sendControlCommand: this.sendControlCommand.bind(this)
      };
    }
    
    /**
     * Start connection monitoring
     */
    startConnectionMonitoring() {
      // Clear any existing interval
      if (connectionMonitorInterval) {
        clearInterval(connectionMonitorInterval);
      }
      
      // Monitor connection status every 5 seconds
      connectionMonitorInterval = setInterval(() => {
        // Check if data channel is active
        if (isConnected && dataChannel && dataChannel.readyState !== 'open') {
          console.warn('Data channel is not open despite connected state, attempting recovery');
          try {
            // Try to recreate data channel
            if (peerConnection && peerConnection.connectionState === 'connected') {
              dataChannel = peerConnection.createDataChannel('control', {
                ordered: true,
                negotiated: false // Let the connection handle negotiation
              });
              this.setupDataChannel(dataChannel);
            } else {
              console.warn('Peer connection not in connected state, cannot recreate data channel');
              // Trigger reconnection only if not already reconnecting
              if (!isConnecting && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                this.handleConnectionFailure('Connection state mismatch');
              }
            }
          } catch (err) {
            console.error('Error recreating data channel:', err);
          }
        }
        
        // Check ICE connection state
        if (isConnected && peerConnection && 
            (peerConnection.iceConnectionState === 'disconnected' || 
             peerConnection.iceConnectionState === 'failed')) {
          console.warn('ICE connection is failing, attempting recovery');
          // Trigger reconnection only if not already reconnecting
          if (!isConnecting && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this.handleConnectionFailure('ICE connection failure');
          }
        }
      }, 5000);
    }
    
    /**
     * Stop connection monitoring
     */
    stopConnectionMonitoring() {
      if (connectionMonitorInterval) {
        clearInterval(connectionMonitorInterval);
        connectionMonitorInterval = null;
      }
    }
    
    /**
     * Set viewer element
     * @param {HTMLElement|String} element - Viewer element or ID
     */
    setViewerElement(element) {
      if (typeof element === 'string') {
        viewerElement = document.getElementById(element);
      } else {
        viewerElement = element;
      }
      
      // Create video element if not already exists
      if (viewerElement && !streamElement) {
        streamElement = document.createElement('video');
        streamElement.autoplay = true;
        streamElement.muted = true;
        streamElement.style.width = '100%';
        streamElement.style.height = 'auto';
        
        // Add stream element to viewer
        viewerElement.appendChild(streamElement);
        
        // Add mouse event listeners if controls enabled
        if (controlsEnabled) {
          this.setupMouseControls();
        }
      }
    }
    
    /**
     * Set up socket event handlers
     */
    setupSocketHandlers() {
      if (!socket) return;
      
      // Handle message event which includes all signaling
      socket.on('message', (data) => {
        // Ensure the message is for us
        if (data.to !== clientId) return;
        
        // Route based on message type
        if (data.type === 'offer') {
          this.handleOffer(data);
        } else if (data.type === 'answer') {
          this.handleAnswer(data);
        } else if (data.type === 'ice-candidate') {
          this.handleIceCandidate(data);
        }
      });
      
      // Direct event handlers for backward compatibility
      socket.on('offer', this.handleOffer.bind(this));
      socket.on('answer', this.handleAnswer.bind(this));
      socket.on('ice-candidate', this.handleIceCandidate.bind(this));
      
      // Handle control response - always assume granted to match Windows app auto-accept
      socket.on('control-response', (data) => {
        console.log('Control access response:', data);
        
        // Enable controls regardless of response since Windows app auto-accepts
        if (!controlsEnabled) {
          this.enableControls();
        }
      });
      
      // Handle connection status updates
      socket.on('device-status-update', (data) => {
        if (data.remotePcId === remotePcId && data.status !== 'online' && isConnected) {
          // Device went offline or idle while connected
          this.disconnect();
          connectionCallbacks.onDisconnected('Device went offline');
        }
      });
      
      // Handle reconnect events
      socket.on('reconnect-attempt', (data) => {
        if (data.remotePcId === remotePcId && !isConnected && !isConnecting) {
          console.log(`Reconnection attempt ${data.attempt} for device ${remotePcId}`);
          
          // Try to reconnect if not already connecting
          if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            this.connect(remotePcId);
          }
        }
      });
      
      // Handle connection errors
      socket.on('connection-error', (data) => {
        console.error('Connection error:', data.error);
        connectionCallbacks.onError(data.error || 'Connection error');
        
        // Reset connecting state
        isConnecting = false;
      });
    }
    
    /**
     * Connect to a device
     * @param {String} targetRemotePcId - Device ID to connect to
     * @returns {Promise} Connection result
     */
    connect(targetRemotePcId) {
      return new Promise(async (resolve, reject) => {
        try {
          // Validate requirements
          if (!socket) {
            throw new Error('Socket not initialized');
          }
          
          if (!viewerElement) {
            throw new Error('Viewer element not set');
          }
          
          // Update device ID if provided
          if (targetRemotePcId) {
            remotePcId = targetRemotePcId;
          }
          
          if (!remotePcId) {
            throw new Error('No device ID specified');
          }
          
          // Disconnect if already connected
          if (isConnected) {
            await this.disconnect();
          }
          
          // Set connecting state
          isConnecting = true;
          
          // Notify connecting
          connectionCallbacks.onConnecting();
          
          // Create peer connection with configuration matching Windows app
          peerConnection = new RTCPeerConnection(config);
          
          // Set up event handlers
          peerConnection.ontrack = this.handleTrack.bind(this);
          peerConnection.onicecandidate = this.handleLocalIceCandidate.bind(this);
          peerConnection.oniceconnectionstatechange = this.handleIceConnectionStateChange.bind(this);
          peerConnection.onconnectionstatechange = this.handleConnectionStateChange.bind(this);
          peerConnection.ondatachannel = this.handleDataChannel.bind(this);
          
          // Create data channel for control commands - match Windows app datachannel name
          dataChannel = peerConnection.createDataChannel('control', {
            ordered: true,
            negotiated: false // Let the connection handle negotiation
          });
          
          // Setup data channel events
          this.setupDataChannel(dataChannel);
          
          // Apply codec preferences - matching Windows app's VP8 restriction
          this.applyCodecPreferences(peerConnection);
          
          // Add video transceivers for screen sharing (this is the key change)
          peerConnection.addTransceiver('video', {
            direction: 'recvonly'
          });
          
          // Create offer with configuration matching SIPSorcery in Windows app
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: true,
            voiceActivityDetection: false
          });
          
          // Set local description - required before sending
          await peerConnection.setLocalDescription(offer);
          
          // Send offer to device - format matches SignalingService.cs expectation
          socket.emit('message', {
            type: 'offer',
            from: clientId,
            to: remotePcId,
            payload: {
              sdp: peerConnection.localDescription.sdp,
              type: peerConnection.localDescription.type
            }
          });
          
          // Set a connection timeout
          const connectionTimeout = setTimeout(() => {
            if (isConnecting && !isConnected) {
              isConnecting = false;
              connectionCallbacks.onError('Connection timeout');
              
              if (peerConnection) {
                try {
                  peerConnection.close();
                } catch (e) {
                  // Ignore errors
                }
                peerConnection = null;
              }
              
              reject(new Error('Connection timeout'));
            }
          }, 30000); // 30 second timeout
          
          // Resolve promise with connection methods
          resolve({
            disconnect: this.disconnect.bind(this),
            sendControlCommand: this.sendControlCommand.bind(this)
          });
          
          // Clear timeout when promise resolves
          clearTimeout(connectionTimeout);
        } catch (error) {
          console.error('Connection error:', error);
          isConnecting = false;
          connectionCallbacks.onError(error.message);
          reject(error);
        }
      });
    }
    
    /**
     * Apply codec preferences to match Windows app's VideoEncoderEndPoint
     * @param {RTCPeerConnection} pc - Peer connection
     */
    async applyCodecPreferences(pc) {
      try {
        // Only proceed if RTCRtpSender.getCapabilities is available
        if (!RTCRtpSender.getCapabilities) {
          console.log('RTCRtpSender.getCapabilities not available, skipping codec preferences');
          return;
        }
        
        // Get available codecs
        const capabilities = RTCRtpSender.getCapabilities('video');
        if (!capabilities) {
          console.log('No video capabilities available');
          return;
        }
        
        // Filter codecs to prioritize VP8 matching Windows app's VideoEncoderEndPoint.RestrictFormats
        const preferredCodecsList = capabilities.codecs.filter(codec => {
          const codecName = codec.mimeType.split('/')[1].toLowerCase();
          return preferredCodecs.some(preferred => codecName.includes(preferred.toLowerCase()));
        });
        
        if (preferredCodecsList.length === 0) {
          console.log('No preferred codecs found');
          return;
        }
        
        // Add the rest of the codecs
        const otherCodecs = capabilities.codecs.filter(codec => {
          const codecName = codec.mimeType.split('/')[1].toLowerCase();
          return !preferredCodecs.some(preferred => codecName.includes(preferred.toLowerCase()));
        });
        
        // Combine preferred codecs first, then others
        const orderedCodecs = [...preferredCodecsList, ...otherCodecs];
        
        // Apply codec preferences to transceiver
        const transceivers = pc.getTransceivers();
        for (const transceiver of transceivers) {
          if (transceiver.sender.track && transceiver.sender.track.kind === 'video' && 
              transceiver.setCodecPreferences) {
            transceiver.setCodecPreferences(orderedCodecs);
            console.log('Applied codec preferences, prioritizing:', preferredCodecs.join(', '));
            break;
          }
        }
      } catch (error) {
        console.error('Error applying codec preferences:', error);
      }
    }
    
    /**
     * Handle connection failure and attempt reconnection
     * @param {String} reason - Failure reason
     */
    handleConnectionFailure(reason) {
      console.warn(`Connection failure: ${reason}`);
      
      // Only attempt reconnect if we were previously connected or still trying to connect
      if (!isConnected && !isConnecting) return;
      
      // Update state
      isConnected = false;
      isConnecting = false;
      
      // Notify disconnection
      connectionCallbacks.onDisconnected(reason);
      
      // Check if device is still online before attempting reconnection
      if (socket) {
        socket.emit('device-status-request', { remotePcId });
      }
      
      // Attempt reconnection with interval matching Windows app ConnectionSettings.cs
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        // Use fixed 30 second interval to match Windows app ConnectionSettings.cs _reconnectInterval
        console.log(`Scheduling reconnection attempt ${reconnectAttempts + 1} in ${RECONNECT_BASE_DELAY/1000}s`);
        
        // Clear any existing timeout
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
        }
        
        // Schedule reconnection
        reconnectTimeout = setTimeout(() => {
          reconnectAttempts++;
          
          // Close existing peer connection properly
          if (peerConnection) {
            try {
              // Close all transceivers
              const transceivers = peerConnection.getTransceivers();
              transceivers.forEach(transceiver => {
                if (transceiver.stop) {
                  transceiver.stop();
                }
              });
              
              peerConnection.close();
            } catch (err) {
              // Ignore errors closing connection
            }
            peerConnection = null;
          }
          
          // Close data channel
          if (dataChannel) {
            try {
              dataChannel.close();
            } catch (err) {
              // Ignore errors
            }
            dataChannel = null;
          }
          
          // Create a fresh connection
          this.connect(remotePcId).catch(err => {
            console.error('Reconnection attempt failed:', err);
          });
        }, RECONNECT_BASE_DELAY);
      } else {
        console.error('Maximum reconnection attempts reached');
      }
    }
    
    /**
     * Disconnect from device
     */
    async disconnect() {
      try {
        // Clear any pending reconnect timeout
        if (reconnectTimeout) {
          clearTimeout(reconnectTimeout);
          reconnectTimeout = null;
        }
        
        // Close peer connection
        if (peerConnection) {
          peerConnection.ontrack = null;
          peerConnection.onicecandidate = null;
          peerConnection.oniceconnectionstatechange = null;
          peerConnection.onconnectionstatechange = null;
          peerConnection.ondatachannel = null;
          
          // Close all transceivers
          const transceivers = peerConnection.getTransceivers();
          transceivers.forEach(transceiver => {
            if (transceiver.stop) {
              transceiver.stop();
            }
          });
          
          // Close peer connection
          peerConnection.close();
          peerConnection = null;
        }
        
        // Clear video element
        if (streamElement) {
          if (streamElement.srcObject) {
            const tracks = streamElement.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            streamElement.srcObject = null;
          }
        }
        
        // Close data channel
        if (dataChannel) {
          dataChannel.close();
          dataChannel = null;
        }
        
        // Send disconnect message to server for the device
        if (socket && remotePcId) {
          socket.emit('message', {
            type: 'disconnect',
            from: clientId,
            to: remotePcId
          });
        }
        
        // Update state
        isConnected = false;
        isConnecting = false;
        
        // Notify disconnected
        connectionCallbacks.onDisconnected();
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    }
    
    /**
     * Set up data channel event handlers
     * @param {RTCDataChannel} channel - Data channel
     */
    setupDataChannel(channel) {
      if (!channel) return;
      
      channel.onopen = () => {
        console.log('Data channel opened');
      };
      
      channel.onclose = () => {
        console.log('Data channel closed');
      };
      
      channel.onerror = (error) => {
        console.error('Data channel error:', error);
      };
      
      channel.onmessage = (event) => {
        try {
          console.log('Data channel message received:', event.data);
          // Process data channel messages here if needed
        } catch (error) {
          console.error('Error processing data channel message:', error);
        }
      };
    }
    
    /**
     * Handle incoming data channel
     * @param {RTCDataChannelEvent} event - Data channel event
     */
    handleDataChannel(event) {
      const channel = event.channel;
      console.log('Data channel received:', channel.label);
      
      // If this is a control channel, set it as our data channel
      if (channel.label === 'control') {
        dataChannel = channel;
        this.setupDataChannel(channel);
      }
    }
    
    /**
     * Handle incoming WebRTC offer
     * @param {Object} data - Offer data
     */
    async handleOffer(data) {
      try {
        // Extract offer details - support multiple formats
        let offerSdp, offerType, fromId;
        
        // Format 1: { remotePcId, offer: { sdp, type } }
        if (data.remotePcId && data.offer) {
          offerSdp = data.offer.sdp;
          offerType = data.offer.type;
          fromId = data.remotePcId;
        }
        // Format 2: { from, to, payload: { sdp, type } }
        else if (data.from && data.to && data.payload) {
          offerSdp = data.payload.sdp;
          offerType = data.payload.type;
          fromId = data.from;
        }
        // Invalid format
        else {
          throw new Error('Invalid offer format');
        }
        
        // Skip if not from our device
        if (fromId !== remotePcId) {
          return;
        }
        
        // Create peer connection if not exists
        if (!peerConnection) {
          peerConnection = new RTCPeerConnection(config);
          
          // Set up event handlers
          peerConnection.ontrack = this.handleTrack.bind(this);
          peerConnection.onicecandidate = this.handleLocalIceCandidate.bind(this);
          peerConnection.oniceconnectionstatechange = this.handleIceConnectionStateChange.bind(this);
          peerConnection.onconnectionstatechange = this.handleConnectionStateChange.bind(this);
          peerConnection.ondatachannel = this.handleDataChannel.bind(this);
        }
        
        // Apply codec preferences - matching Windows app's VP8 restriction
        this.applyCodecPreferences(peerConnection);
        
        // Create RTCSessionDescription for offer
        const offerDesc = new RTCSessionDescription({
          sdp: offerSdp,
          type: offerType
        });
        
        // Apply remote description
        await peerConnection.setRemoteDescription(offerDesc);
        
        // Create answer
        const answer = await peerConnection.createAnswer();
        
        // Set local description
        await peerConnection.setLocalDescription(answer);
        
        // Send answer - matching Windows app expected format exactly
        socket.emit('message', {
          type: 'answer',
          from: clientId,
          to: remotePcId,
          payload: {
            sdp: answer.sdp,
            type: answer.type
          }
        });
      } catch (error) {
        console.error('Error handling offer:', error);
        connectionCallbacks.onError('Failed to process offer: ' + error.message);
      }
    }
    
    /**
     * Handle incoming WebRTC answer
     * @param {Object} data - Answer data
     */
    async handleAnswer(data) {
      try {
        // Extract answer from different possible formats
        let answerSdp, answerType, fromId;
        
        // Format 1: { remotePcId, answer: { sdp, type } }
        if (data.remotePcId && data.answer) {
          answerSdp = data.answer.sdp;
          answerType = data.answer.type;
          fromId = data.remotePcId;
        }
        // Format 2: { from, to, payload: { sdp, type } }
        else if (data.from && data.to && data.payload) {
          answerSdp = data.payload.sdp;
          answerType = data.payload.type;
          fromId = data.from;
        }
        // Invalid format
        else {
          throw new Error('Invalid answer format');
        }
        
        // Skip if not from our device or no peer connection
        if (fromId !== remotePcId || !peerConnection) {
          return;
        }
        
        // Set remote description
        const answerDesc = new RTCSessionDescription({
          sdp: answerSdp,
          type: answerType
        });
        
        await peerConnection.setRemoteDescription(answerDesc);
        
        // Mark connection as established when remote description is set
        isConnecting = false;
        
        // Reset reconnection attempts on successful connection
        reconnectAttempts = 0;
      } catch (error) {
        console.error('Error handling answer:', error);
        connectionCallbacks.onError('Failed to process answer: ' + error.message);
      }
    }
    
    /**
     * Handle incoming ICE candidate
     * @param {Object} data - ICE candidate data
     */
    async handleIceCandidate(data) {
      try {
        // Extract candidate from different possible formats
        let candidateObj, fromId;
        
        // Format 1: { remotePcId, candidate: { candidate, sdpMLineIndex, sdpMid } }
        if (data.remotePcId && data.candidate) {
          candidateObj = data.candidate;
          fromId = data.remotePcId;
        }
        // Format 2: { from, to, payload: { candidate, sdpMLineIndex, sdpMid } }
        else if (data.from && data.to && data.payload) {
          candidateObj = data.payload;
          fromId = data.from;
        } else {
          return; // Silently ignore invalid formats
        }
        
        // Skip if not from our device or no peer connection
        if (fromId !== remotePcId || !peerConnection) {
          return;
        }
        
        // Add ice candidate if valid
        if (candidateObj && candidateObj.candidate) {
          const candidate = new RTCIceCandidate({
            candidate: candidateObj.candidate,
            sdpMLineIndex: candidateObj.sdpMLineIndex,
            sdpMid: candidateObj.sdpMid
          });
          
          await peerConnection.addIceCandidate(candidate);
        }
      } catch (error) {
        console.error('Error handling ICE candidate:', error);
      }
    }
    
    /**
     * Handle local ICE candidate
     * @param {Object} event - ICE candidate event
     */
    handleLocalIceCandidate(event) {
      if (!event.candidate) return;
      
      try {
        // Send ICE candidate to device - format matches Windows app expectation
        socket.emit('message', {
          type: 'ice-candidate',
          from: clientId,
          to: remotePcId,
          payload: {
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid
          }
        });
      } catch (error) {
        console.error('Error sending ICE candidate:', error);
      }
    }
    
    /**
     * Handle ICE connection state change
     */
    handleIceConnectionStateChange() {
      if (!peerConnection) return;
      
      const state = peerConnection.iceConnectionState;
      console.log('ICE connection state:', state);
      
      switch (state) {
        case 'connected':
        case 'completed':
          if (!isConnected) {
            isConnected = true;
            isConnecting = false;
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            connectionCallbacks.onConnected();
          }
          break;
        case 'failed':
          // If connection was previously established, try to recover
          if (isConnected) {
            this.handleConnectionFailure('ICE connection failed');
          } else if (isConnecting) {
            isConnecting = false;
            connectionCallbacks.onError('ICE connection failed during setup');
          }
          break;
        case 'disconnected':
          // Wait for reconnection attempt by ICE layer, but prepare for potential failure
          console.warn('ICE connection disconnected, waiting for recovery');
          
          // Set a timer to check if we recover automatically
          setTimeout(() => {
            if (peerConnection && peerConnection.iceConnectionState === 'disconnected') {
              // Still disconnected after delay, try to force reconnection
              this.handleConnectionFailure('ICE connection recovery timeout');
            }
          }, 5000); // Wait 5 seconds for auto-recovery
          break;
        case 'closed':
          if (isConnected) {
            isConnected = false;
            connectionCallbacks.onDisconnected('Connection closed');
          }
          break;
      }
    }
    
    /**
     * Handle connection state change
     */
    handleConnectionStateChange() {
      if (!peerConnection) return;
      
      const state = peerConnection.connectionState;
      console.log('Connection state:', state);
      
      switch (state) {
        case 'connected':
          if (!isConnected) {
            isConnected = true;
            isConnecting = false;
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            connectionCallbacks.onConnected();
          }
          break;
        case 'failed':
          // If connection was previously established, try to recover
          if (isConnected) {
            this.handleConnectionFailure('Connection failed');
          } else if (isConnecting) {
            isConnecting = false;
            connectionCallbacks.onError('Connection failed during setup');
            
            // Check if the device is still online
            if (socket) {
              socket.emit('device-status-request', {
                remotePcId: remotePcId
              });
            }
          }
          break;
        case 'closed':
          if (isConnected) {
            isConnected = false;
            connectionCallbacks.onDisconnected('Connection closed');
          }
          break;
      }
    }
    
    /**
     * Handle remote track
     * @param {Object} event - Track event
     */
    handleTrack(event) {
      if (streamElement && event.streams && event.streams[0]) {
        streamElement.srcObject = event.streams[0];
        
        // Log resolution when track is added
        const videoTrack = event.streams[0].getVideoTracks()[0];
        if (videoTrack) {
          console.log('Video track added:', videoTrack.getSettings());
          
          // When video starts playing, signal connection is fully established
          streamElement.onloadedmetadata = () => {
            console.log('Video stream loaded, dimensions:', 
                      streamElement.videoWidth, 'x', streamElement.videoHeight);
          };
        }
      }
    }
    
    /**
     * Enable mouse controls
     */
    enableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = true;
      this.setupMouseControls();
    }
    
    /**
     * Disable mouse controls
     */
    disableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = false;
      this.removeMouseControls();
    }
    
    /**
     * Set up mouse control event listeners
     */
    setupMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove existing listeners
      this.removeMouseControls();
      
      // Add mouse event listeners
      streamElement.addEventListener('mousedown', this.handleMouseDown);
      streamElement.addEventListener('mouseup', this.handleMouseUp);
      streamElement.addEventListener('mousemove', this.handleMouseMove);
      streamElement.addEventListener('wheel', this.handleMouseWheel);
      streamElement.addEventListener('contextmenu', this.handleContextMenu);
      
      // Add keyboard event listeners to document
      document.addEventListener('keydown', this.handleKeyDown);
      document.addEventListener('keyup', this.handleKeyUp);
      
      // Add touch event listeners for mobile
      streamElement.addEventListener('touchstart', this.handleTouchStart);
      streamElement.addEventListener('touchend', this.handleTouchEnd);
      streamElement.addEventListener('touchmove', this.handleTouchMove);
    }
    
    /**
     * Remove mouse control event listeners
     */
    removeMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove mouse event listeners
      streamElement.removeEventListener('mousedown', this.handleMouseDown);
      streamElement.removeEventListener('mouseup', this.handleMouseUp);
      streamElement.removeEventListener('mousemove', this.handleMouseMove);
      streamElement.removeEventListener('wheel', this.handleMouseWheel);
      streamElement.removeEventListener('contextmenu', this.handleContextMenu);
      
      // Remove keyboard event listeners
      document.removeEventListener('keydown', this.handleKeyDown);
      document.removeEventListener('keyup', this.handleKeyUp);
      
      // Remove touch event listeners
      streamElement.removeEventListener('touchstart', this.handleTouchStart);
      streamElement.removeEventListener('touchend', this.handleTouchEnd);
      streamElement.removeEventListener('touchmove', this.handleTouchMove);
    }
    
    /**
     * Send control command to device
     * Format exactly matches Windows app InputService.cs expectations
     * @param {Object} command - Control command
     * @returns {Boolean} Whether the command was sent successfully
     */
    sendControlCommand(command) {
      if (!isConnected) {
        console.warn('Cannot send control command: not connected');
        return false;
      }
      
      try {
        // Validate command format to exactly match Windows app InputService.cs expectations
        let validatedCommand;
        
        if (typeof command === 'string') {
          try {
            // Parse JSON string to validate
            validatedCommand = JSON.parse(command);
            
            // Convert back to string after validation
            validatedCommand = command;
          } catch (e) {
            // Not valid JSON, use as is
            validatedCommand = command;
          }
        } else if (typeof command === 'object') {
          // Ensure required fields based on command type
          if (!command.type) {
            throw new Error('Command missing required type field');
          }
          
          // Validate command format based on type - formats match InputService.cs exactly
          switch (command.type) {
            case 'MouseMove':
              if (typeof command.x !== 'number' || typeof command.y !== 'number') {
                throw new Error('MouseMove command missing x or y coordinates');
              }
              // Make sure to include isRelative field - Windows app expects this
              if (command.isRelative === undefined) {
                command.isRelative = false;
              }
              break;
            case 'MouseDown':
            case 'MouseUp':
              if (!command.button) {
                throw new Error(`${command.type} command missing button field`);
              }
              break;
            case 'MouseClick':
              if (!command.button) {
                throw new Error('MouseClick command missing button field');
              }
              // If coordinates provided, ensure they are numbers
              if (command.x !== undefined && command.y !== undefined) {
                if (typeof command.x !== 'number' || typeof command.y !== 'number') {
                  throw new Error('MouseClick command has invalid x or y coordinates');
                }
              }
              break;
            case 'MouseScroll':
              if (typeof command.scrollDelta !== 'number') {
                throw new Error('MouseScroll command missing or invalid scrollDelta');
              }
              break;
            case 'KeyPress':
            case 'KeyDown':
            case 'KeyUp':
              if (typeof command.keyCode !== 'number') {
                throw new Error(`${command.type} command missing or invalid keyCode`);
              }
              break;
            case 'Text':
              if (typeof command.text !== 'string') {
                throw new Error('Text command missing or invalid text');
              }
              break;
            default:
              throw new Error(`Unknown command type: ${command.type}`);
          }
          
          // Convert to string after validation
          validatedCommand = JSON.stringify(command);
        } else {
          throw new Error('Invalid command format');
        }
        
        // Send through data channel if available
        if (dataChannel && dataChannel.readyState === 'open') {
          // Windows app expects raw command format in data channel
          dataChannel.send(validatedCommand);
          return true;
        }
        
        // Fall back to signaling channel if data channel isn't available
        if (socket) {
          // When using socket, Windows app expects wrapped format with type and command
          socket.emit('control-command', {
            remotePcId: remotePcId,
            command: validatedCommand
          });
          return true;
        }
        
        return false;
      } catch (error) {
        console.error('Error sending control command:', error);
        return false;
      }
    }
    
    /**
     * Convert event coordinates to normalized coordinates
     * @param {Event} event - Mouse or touch event
     * @returns {Object|null} Normalized coordinates
     */
    getNormalizedCoordinates(event) {
      try {
        const rect = streamElement.getBoundingClientRect();
        const scaleX = streamElement.videoWidth / rect.width;
        const scaleY = streamElement.videoHeight / rect.height;
        
        let x, y;
        
        if (event.type.startsWith('touch')) {
          // Touch event
          if (event.touches.length > 0) {
            x = (event.touches[0].clientX - rect.left) * scaleX;
            y = (event.touches[0].clientY - rect.top) * scaleY;
          } else {
            // No touches available
            return null;
          }
        } else {
          // Mouse event
          x = (event.clientX - rect.left) * scaleX;
          y = (event.clientY - rect.top) * scaleY;
        }
        
        // Ensure coordinates are non-negative and within bounds
        x = Math.max(0, Math.min(streamElement.videoWidth, Math.round(x)));
        y = Math.max(0, Math.min(streamElement.videoHeight, Math.round(y)));
        
        return { x, y };
      } catch (error) {
        console.error('Error calculating normalized coordinates:', error);
        return null;
      }
    }
  }
  
  // Event handlers - defined as properties of the prototype
  WebRTCClient.prototype.handleMouseDown = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    let button;
    switch (event.button) {
      case 0: button = 'Left'; break;   // Exact capitalization matches Windows app
      case 1: button = 'Middle'; break; // Exact capitalization matches Windows app
      case 2: button = 'Right'; break;  // Exact capitalization matches Windows app
      default: button = 'Left';
    }
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseDown",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleMouseUp = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    let button;
    switch (event.button) {
      case 0: button = 'Left'; break;
      case 1: button = 'Middle'; break;
      case 2: button = 'Right'; break;
      default: button = 'Left';
    }
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseUp",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleMouseMove = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Throttle mouse move events to reduce load - match Windows app frame rate
    if (!instance.handleMouseMove.lastSent || Date.now() - instance.handleMouseMove.lastSent > 50) {
      // Format exactly matches Windows InputService.cs
      instance.sendControlCommand({
        type: "MouseMove",
        x: coords.x,
        y: coords.y,
        isRelative: false
      });
      
      instance.handleMouseMove.lastSent = Date.now();
    }
  };
  
  WebRTCClient.prototype.handleMouseWheel = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const delta = Math.sign(event.deltaY) * -1; // Invert delta for natural scrolling
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseScroll",
      scrollDelta: delta
    });
  };
  
  WebRTCClient.prototype.handleContextMenu = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault(); // Prevent browser context menu
  };
  
  WebRTCClient.prototype.handleKeyDown = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    // Focus is on the viewer element or it's within the document
    if (!event.target.closest('#screen-view') && event.target !== document.documentElement) {
      return;
    }
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "KeyDown",
      keyCode: event.keyCode
    });
  };
  
  WebRTCClient.prototype.handleKeyUp = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    // Focus is on the viewer element or it's within the document
    if (!event.target.closest('#screen-view') && event.target !== document.documentElement) {
      return;
    }
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "KeyUp",
      keyCode: event.keyCode
    });
  };
  
  WebRTCClient.prototype.handleTouchStart = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    // Store touch start time for detecting long press
    instance.handleTouchStart.startTime = Date.now();
    instance.handleTouchStart.startPosition = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY
    };
    
    // Check if multiple touches (simulated right click)
    const button = event.touches.length > 1 ? 'Right' : 'Left';
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseDown",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleTouchEnd = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    // Calculate touch duration for long press detection
    const duration = Date.now() - (instance.handleTouchStart.startTime || 0);
    const button = duration > 500 ? 'Right' : 'Left'; // Long press as right click
    
    // Use the last known coordinates since there are no coordinates in touchend
    const coords = instance.getNormalizedCoordinates({
      type: 'touch',
      touches: [{
        clientX: instance.handleTouchStart.startPosition?.x || 0,
        clientY: instance.handleTouchStart.startPosition?.y || 0
      }]
    });
    
    if (!coords) return;
    
    // Format exactly matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseUp",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleTouchMove = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Throttle touch move events to reduce load - match Windows app frame rate
    if (!instance.handleTouchMove.lastSent || Date.now() - instance.handleTouchMove.lastSent > 50) {
      // Format exactly matches Windows InputService.cs
      instance.sendControlCommand({
        type: "MouseMove",
        x: coords.x,
        y: coords.y,
        isRelative: false
      });
      
      instance.handleTouchMove.lastSent = Date.now();
    }
  };
  
  // Create and return singleton instance
  return {
    initialize: function(options) {
      if (!instance) {
        instance = new WebRTCClient();
      }
      return instance.initialize(options);
    }
  };
})();