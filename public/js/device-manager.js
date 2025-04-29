/**
 * device-manager.js
 * Handles device management and remote viewer functionality
 * Updated to fix undefined remotePcId error when viewing device details
 */

// Global variables
let devices = [];
let rtcClient = null;
let viewerSocket = null;
let sessionStartTime = null;
let sessionTimer = null;
let controlEnabled = true;
let clientId = getOrCreateClientId(); // Use persistent client ID
let reconnectAttempts = 0;
let connectionMonitorInterval = null;
let isConnecting = false;
const MAX_RECONNECT_ATTEMPTS = 5; // Match Windows app setting
const RECONNECT_INTERVAL = 30000; // 30 seconds - match Windows app ConnectionSettings.cs _reconnectInterval

/**
 * Get existing client ID from localStorage or create a new one
 * Updated to match Windows app naming convention
 * @returns {string} Client ID
 */
function getOrCreateClientId() {
    // Try to get existing client ID first with new name
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
        console.log('Created new Web client ID:', storedClientId);
    } else {
        console.log('Using existing Web client ID:', storedClientId);
    }
    
    return storedClientId;
}

/**
 * Store and retrieve session data for reuse
 * Added to match Windows app SessionManager.cs
 */
function storeSessionId(sid, timestamp = Date.now()) {
    try {
        // Store session data in the format expected by Windows app SessionManager.cs
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

document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Check if authenticated - This assumes dashboard-ui.js is loaded first
        // and has already done the authentication check
        if (document.body.classList.contains('not-authenticated')) {
            return;
        }
        
        // Initialize device management
        await initDeviceManagement();
        
        // Initialize socket updates
        const socket = initSocketUpdates();
        
        // Add event listeners for viewer section
        initViewerControls();
    } catch (error) {
        console.error('Device management initialization error:', error);
    }
});

/**
 * Initialize device management
 */
async function initDeviceManagement() {
    // Add event listeners
    document.getElementById('refresh-devices-btn').addEventListener('click', fetchDevices);
    document.getElementById('status-filter').addEventListener('change', filterDevices);
    document.getElementById('device-search').addEventListener('input', filterDevices);
    
    // Fetch devices
    await fetchDevices();
    
    // Set up automatic refresh every 30 seconds
    setInterval(fetchDevices, 30000);
}

/**
 * Fetch devices from API
 */
async function fetchDevices() {
    try {
        const deviceList = document.getElementById('device-list');
        
        // Show loading indicator
        deviceList.innerHTML = `
            <div class="loading-devices">
                <div class="spinner">
                    <i class="fas fa-spinner fa-spin"></i>
                </div>
                <p>Loading devices...</p>
            </div>
        `;
        
        // Make API request
        const response = await fetch('/api/devices', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${Auth.getToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch devices');
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.message || 'Failed to fetch devices');
        }
        
        // Store devices
        devices = data.devices;
        
        // Filter and render devices
        filterDevices();
    } catch (error) {
        console.error('Error fetching devices:', error);
        
        // Show error message
        const deviceList = document.getElementById('device-list');
        deviceList.innerHTML = `
            <div class="device-list-error">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Failed to load devices. Please try again.</p>
                <button class="btn btn-sm" onclick="fetchDevices()">
                    <i class="fas fa-sync-alt"></i> Retry
                </button>
            </div>
        `;
    }
}

/**
 * Filter and render devices
 */
function filterDevices() {
    // Get filter values
    const statusFilter = document.getElementById('status-filter').value;
    const searchText = document.getElementById('device-search').value.toLowerCase();
    
    // Filter devices
    const filteredDevices = devices.filter(device => {
        // Status filter
        if (statusFilter !== 'all' && device.status !== statusFilter) {
            return false;
        }
        
        // Search filter
        if (searchText && !device.systemName.toLowerCase().includes(searchText)) {
            return false;
        }
        
        return true;
    });
    
    // Render devices
    renderDevices(filteredDevices);
}

/**
 * Render devices to DOM
 */
function renderDevices(filteredDevices) {
    const deviceList = document.getElementById('device-list');
    
    // Clear existing content
    deviceList.innerHTML = '';
    
    // Check if no devices
    if (filteredDevices.length === 0) {
        deviceList.innerHTML = `
            <div class="no-devices">
                <i class="fas fa-laptop-house"></i>
                <p>No devices found matching the filters.</p>
            </div>
        `;
        return;
    }
    
    // Create device cards
    filteredDevices.forEach(device => {
        // CRITICAL FIX: Ensure device.remotePcId exists before proceeding
        if (!device.remotePcId) {
            console.warn('Device without remotePcId found:', device);
            return; // Skip this device
        }
        
        const deviceCard = document.createElement('div');
        deviceCard.className = `device-card ${device.status || 'unknown'}`;
        
        // CRITICAL FIX: Consistently use remotePcId as HTML attribute name
        deviceCard.setAttribute('data-remote-pc-id', device.remotePcId);
        
        // Format last seen time
        const lastSeen = device.lastSeen ? formatTimeAgo(new Date(device.lastSeen)) : 'Never';
        
        // Create device card content
        deviceCard.innerHTML = `
            <div class="device-info">
                <div class="device-name">
                    <h4>${device.systemName || 'Unknown Device'}</h4>
                    <span class="device-id">${device.remotePcId}</span>
                </div>
                <div class="device-status">
                    <span class="status-indicator ${device.status || 'unknown'}"></span>
                    <span class="status-text">${capitalizeFirstLetter(device.status || 'unknown')}</span>
                </div>
            </div>
            <div class="device-meta">
                <span class="device-last-seen">
                    <i class="fas fa-clock"></i> Last seen: ${lastSeen}
                </span>
                <span class="device-connection">
                    <i class="fas fa-plug"></i> Connections: ${device.connections || 0}
                </span>
            </div>
            <div class="device-actions">
                <button class="btn btn-sm connect-btn" ${(device.status !== 'online') ? 'disabled' : ''}>
                    <i class="fas fa-desktop"></i> Connect
                </button>
                <button class="btn btn-sm view-details-btn">
                    <i class="fas fa-info-circle"></i> Details
                </button>
            </div>
        `;
        
        // Add event listeners
        const connectBtn = deviceCard.querySelector('.connect-btn');
        connectBtn.addEventListener('click', () => {
            connectToDevice(device.remotePcId);
        });
        
        const detailsBtn = deviceCard.querySelector('.view-details-btn');
        detailsBtn.addEventListener('click', () => {
            // CRITICAL FIX: Pass the remotePcId directly from the device object
            viewDeviceDetails(device.remotePcId);
        });
        
        // Add to list
        deviceList.appendChild(deviceCard);
    });
}

/**
 * Connect to device
 */
function connectToDevice(remotePcId) {
    // CRITICAL FIX: Add validation to prevent undefined remotePcId
    if (!remotePcId) {
        console.error('Cannot connect to device: remotePcId is undefined');
        return;
    }
    
    // Show remote viewer section
    showRemoteViewerSection();
    
    // Initialize viewer with device ID - assume control will be granted automatically
    document.getElementById('control-toggle').classList.add('active');
    controlEnabled = true;
    
    // Reset connection state
    isConnecting = false;
    reconnectAttempts = 0;
    
    // Initialize viewer
    initViewer(remotePcId);
}

/**
 * Show device list section
 */
function showDeviceListSection() {
    document.getElementById('device-list-section').classList.add('active');
    document.getElementById('remote-viewer-section').classList.remove('active');
    
    // Update page title
    document.getElementById('page-title').textContent = 'Dashboard';
    
    // Refresh device list
    fetchDevices();
}

/**
 * Show remote viewer section
 */
function showRemoteViewerSection() {
    document.getElementById('device-list-section').classList.remove('active');
    document.getElementById('remote-viewer-section').classList.add('active');
    
    // Update page title
    document.getElementById('page-title').textContent = 'Remote Viewer';
}

/**
 * View device details
 */
function viewDeviceDetails(remotePcId) {
    // CRITICAL FIX: Add validation to prevent undefined remotePcId
    if (!remotePcId) {
        console.error('Cannot view device details: remotePcId is undefined');
        return;
    }
    
    // CRITICAL FIX: Ensure retry button has the remotePcId for reconnection
    const retryButton = document.getElementById('retry-button');
    if (retryButton) {
        retryButton.setAttribute('data-remote-pc-id', remotePcId);
    }
    
    // Implement device details modal or page
    // For now, just open connection page
    connectToDevice(remotePcId);
}

/**
 * Format time ago
 */
function formatTimeAgo(date) {
    if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
        return 'Unknown';
    }
    
    const now = new Date();
    const diff = now - date;
    
    // Less than a minute
    if (diff < 60000) {
        return 'Just now';
    }
    
    // Less than an hour
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    }
    
    // Less than a day
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }
    
    // Less than a week
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    }
    
    // Format date
    return date.toLocaleDateString();
}

/**
 * Capitalize first letter
 */
function capitalizeFirstLetter(string) {
    // Add null check to prevent error with undefined values
    if (!string) return 'Unknown';
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Initialize socket for real-time updates
 */
function initSocketUpdates() {
    try {
        // Get stored session ID for reuse if available
        const sessionId = getStoredSessionId();
        
        // Connect to Socket.IO server with client ID matching Windows app expectations
        const socket = io('', {
            path: '/signal/', // Updated to match Windows app's SignalingService.cs path
            query: {
                type: 'dashboard',
                clientId: clientId // Use the persistent client ID
            },
            auth: {
                token: Auth.getToken(),
                sid: sessionId // Include session ID if available
            },
            reconnection: true,
            reconnectionAttempts: MAX_RECONNECT_ATTEMPTS, // Match Windows app
            reconnectionDelay: RECONNECT_INTERVAL, // Match Windows app RECONNECT_INTERVAL
            reconnectionDelayMax: RECONNECT_INTERVAL,
            timeout: 20000
        });
        
        // Store session ID when received in handshake
        socket.on('connect', () => {
            const sid = socket.id;
            if (sid) {
                storeSessionId(sid);
            }
            // Log socket reconnection
            console.log('Socket reconnected');
        });
        
        // Listen for device status updates
        socket.on('device-status-update', (data) => {
            // CRITICAL FIX: Check if remotePcId exists in update
            if (!data || !data.remotePcId) {
                console.warn('Received device status update without remotePcId:', data);
                return;
            }
            
            // Find device in list
            const deviceIndex = devices.findIndex(d => d.remotePcId === data.remotePcId);
            
            if (deviceIndex !== -1) {
                // Update device status
                devices[deviceIndex].status = data.status;
                devices[deviceIndex].lastSeen = data.timestamp;
                
                // Update UI if already rendered
                const deviceCard = document.querySelector(`div[data-remote-pc-id="${data.remotePcId}"]`);
                if (deviceCard) {
                    // Update status classes
                    deviceCard.className = `device-card ${data.status}`;
                    
                    // Update status indicator
                    const statusIndicator = deviceCard.querySelector('.status-indicator');
                    if (statusIndicator) {
                        statusIndicator.className = `status-indicator ${data.status}`;
                    }
                    
                    // Update status text
                    const statusText = deviceCard.querySelector('.status-text');
                    if (statusText) {
                        statusText.textContent = capitalizeFirstLetter(data.status);
                    }
                    
                    // Update last seen
                    const lastSeen = deviceCard.querySelector('.device-last-seen');
                    if (lastSeen) {
                        lastSeen.innerHTML = `<i class="fas fa-clock"></i> Last seen: ${formatTimeAgo(new Date(data.timestamp))}`;
                    }
                    
                    // Update connect button
                    const connectBtn = deviceCard.querySelector('.connect-btn');
                    if (connectBtn) {
                        if (data.status === 'online') {
                            connectBtn.removeAttribute('disabled');
                        } else {
                            connectBtn.setAttribute('disabled', 'disabled');
                        }
                    }
                }
            } else {
                // New device, refetch all devices
                fetchDevices();
            }
        });
        
        // Handle device-list response
        socket.on('device-list', (deviceList) => {
            // CRITICAL FIX: Filter out devices without remotePcId
            if (Array.isArray(deviceList)) {
                devices = deviceList.filter(device => !!device.remotePcId);
                if (devices.length < deviceList.length) {
                    console.warn(`Filtered out ${deviceList.length - devices.length} devices with missing remotePcId`);
                }
            } else {
                console.warn('Received invalid device list:', deviceList);
                devices = [];
            }
            
            // Filter and render devices
            filterDevices();
        });
        
        // Listen for connection error
        socket.on('connection-error', (data) => {
            console.error('Connection error:', data.error);
            showError(data.error || 'Failed to connect to device');
            
            // Reset connecting state
            isConnecting = false;
        });
        
        // Listen for socket disconnect
        socket.on('disconnect', () => {
            console.log('Socket disconnected');
        });
        
        // Listen for reconnection attempts
        socket.on('reconnect-attempt', (data) => {
            // CRITICAL FIX: Check if remotePcId exists in reconnect attempt
            if (!data || !data.remotePcId) {
                console.warn('Received reconnect attempt without remotePcId:', data);
                return;
            }
            
            console.log(`Reconnection attempt ${data.attempt} for device ${data.remotePcId}`);
            
            // If we're currently viewing this device and not already connecting,
            // try to reconnect
            const retryButton = document.getElementById('retry-button');
            if (retryButton) {
                // CRITICAL FIX: Use consistent attribute name for remotePcId
                const currentRemotePcId = retryButton.getAttribute('data-remote-pc-id');
                
                if (currentRemotePcId === data.remotePcId) {
                    if (!isConnecting && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        console.log('Attempting to reconnect to device...');
                        reconnectAttempts++;
                        initViewer(data.remotePcId);
                    }
                }
            }
        });
        
        return socket;
    } catch (error) {
        console.error('Error initializing socket:', error);
        return null;
    }
}

/**
 * Initialize viewer controls
 */
function initViewerControls() {
    try {
        // Back button
        const backButton = document.getElementById('back-to-devices-button');
        if (backButton) {
            backButton.addEventListener('click', function() {
                disconnectFromDevice();
                showDeviceListSection();
            });
        }
        
        // Control toggle button
        const controlToggle = document.getElementById('control-toggle');
        if (controlToggle) {
            controlToggle.addEventListener('click', toggleControl);
        }
        
        // Fullscreen button
        const fullscreenButton = document.getElementById('fullscreen-button');
        if (fullscreenButton) {
            fullscreenButton.addEventListener('click', toggleFullscreen);
        }
        
        // Refresh button
        const refreshButton = document.getElementById('refresh-button');
        if (refreshButton) {
            refreshButton.addEventListener('click', refreshConnection);
        }
        
        // Disconnect button
        const disconnectButton = document.getElementById('disconnect-button');
        if (disconnectButton) {
            disconnectButton.addEventListener('click', function() {
                disconnectFromDevice();
                showDeviceListSection();
            });
        }
        
        // Retry button
        const retryButton = document.getElementById('retry-button');
        if (retryButton) {
            retryButton.addEventListener('click', function() {
                // CRITICAL FIX: Use consistent attribute name for remotePcId
                const currentRemotePcId = retryButton.getAttribute('data-remote-pc-id');
                if (currentRemotePcId) {
                    reconnectAttempts = 0; // Reset reconnect attempts
                    initViewer(currentRemotePcId);
                } else {
                    console.error('Cannot retry: Missing remotePcId on retry button');
                }
            });
        }
        
        // Start connection monitoring
        startConnectionMonitoring();
    } catch (error) {
        console.error('Error initializing viewer controls:', error);
    }
}

/**
 * Start connection monitoring
 */
function startConnectionMonitoring() {
    // Clear any existing interval
    if (connectionMonitorInterval) {
        clearInterval(connectionMonitorInterval);
    }
    
    // Monitor connection status every 5 seconds
    connectionMonitorInterval = setInterval(() => {
        // If connected to a device, check status
        if (rtcClient && rtcClient.isConnected()) {
            // Request device status update
            if (viewerSocket) {
                // CRITICAL FIX: Use consistent attribute name for remotePcId
                const retryButton = document.getElementById('retry-button');
                const remotePcId = retryButton ? retryButton.getAttribute('data-remote-pc-id') : null;
                
                if (remotePcId) {
                    viewerSocket.emit('device-status-request', {
                        remotePcId: remotePcId
                    });
                }
            }
        }
    }, 5000);
}

/**
 * Stop connection monitoring
 */
function stopConnectionMonitoring() {
    if (connectionMonitorInterval) {
        clearInterval(connectionMonitorInterval);
        connectionMonitorInterval = null;
    }
}

/**
 * Initialize the remote viewer
 * @param {string} remotePcId - Device ID to connect to
 */
async function initViewer(remotePcId) {
    try {
        // CRITICAL FIX: Add validation to prevent undefined remotePcId
        if (!remotePcId) {
            showError('Cannot connect: Device ID is missing or undefined');
            return;
        }
        
        // Set connecting state
        isConnecting = true;
        
        // Show loading indicator
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) loadingIndicator.classList.remove('hidden');
        
        const connectionError = document.getElementById('connection-error');
        if (connectionError) connectionError.classList.add('hidden');
        
        const screenView = document.getElementById('screen-view');
        if (screenView) screenView.innerHTML = '';
        
        // Update connection status
        const connectionStatus = document.getElementById('connection-status');
        if (connectionStatus) connectionStatus.textContent = 'Connecting...';
        
        // CRITICAL FIX: Store device ID on retry button with consistent attribute name
        const retryButton = document.getElementById('retry-button');
        if (retryButton) {
            retryButton.setAttribute('data-remote-pc-id', remotePcId);
        }
        
        // Disconnect existing connection if any
        disconnectFromDevice();
        
        // Clear any reconnection timers
        for (let i = 0; i < 100; i++) {
            clearTimeout(i);
        }

        // Reset reconnection attempts
        reconnectAttempts = 0;
        
        // Fetch device information
        await fetchDeviceInfo(remotePcId);
        
        // Get stored session ID for reuse if available
        const sessionId = getStoredSessionId();
        
        // Connect to Socket.IO server with consistent client ID
        viewerSocket = io('', {
            path: '/signal/', // Updated to match Windows app SignalingService.cs
            query: {
                type: 'dashboard',
                clientId: clientId // Use the persistent client ID
            },
            auth: {
                token: Auth.getToken(),
                sid: sessionId // Include session ID if available
            },
            reconnection: true,
            reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
            reconnectionDelay: RECONNECT_INTERVAL, // Match Windows app
            reconnectionDelayMax: RECONNECT_INTERVAL,
            timeout: 20000
        });
        
        // Wait for socket connection
        await new Promise((resolve, reject) => {
            viewerSocket.on('connect', () => {
                // Store session ID from connection
                const sid = viewerSocket.id;
                if (sid) {
                    storeSessionId(sid);
                }
                resolve();
            });
            viewerSocket.on('connect_error', reject);
            viewerSocket.on('error', reject);
            
            // Set timeout for connection
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);
            
            // Clear timeout on connect
            viewerSocket.on('connect', () => clearTimeout(timeout));
        });
        
        // Add event listener for device status updates
        viewerSocket.on('device-status-update', (data) => {
            if (data.remotePcId === remotePcId && data.status === 'online' && 
                rtcClient && rtcClient.isConnecting && !rtcClient.isConnected()) {
                console.log('Device is online but connection failed, attempting to reconnect');
                reconnectAttempts = 0;
                initViewer(remotePcId);
            }
        });
        
        // Initialize WebRTC client - MODIFIED TO ALWAYS ENABLE CONTROLS & SPECIFY VP8 CODEC
        rtcClient = WynzioWebRTC.initialize({
            socket: viewerSocket,
            viewerElement: 'screen-view',
            remotePcId: remotePcId,
            clientId: clientId, // Use the persistent client ID
            enableControls: true, // Always enable controls - no permission needed
            preferredCodecs: ['VP8'], // Match Windows app VideoEncoderEndPoint VP8 restriction
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ],
            onConnecting: () => {
                const connectionStatus = document.getElementById('connection-status');
                if (connectionStatus) connectionStatus.textContent = 'Establishing WebRTC connection...';
            },
            onConnected: () => {
                // Hide loading indicator
                const loadingIndicator = document.getElementById('loading-indicator');
                if (loadingIndicator) loadingIndicator.classList.add('hidden');
                
                // Update connection status
                const connectionStatus = document.getElementById('connection-status');
                if (connectionStatus) connectionStatus.textContent = 'Connected';
                
                // Reset connecting state
                isConnecting = false;
                
                // Reset reconnection attempts
                reconnectAttempts = 0;
                
                // Start session timer
                startSessionTimer();
                
                // Update control button state - always active
                updateControlButtonState();
            },
            onDisconnected: (reason) => {
                const connectionStatus = document.getElementById('connection-status');
                if (connectionStatus) connectionStatus.textContent = 'Disconnected: ' + (reason || 'Unknown reason');
                
                // Reset connecting state
                isConnecting = false;
                
                // Stop session timer
                if (sessionTimer) {
                    clearInterval(sessionTimer);
                    sessionTimer = null;
                }
                
                // Show connection error
                showError('Connection closed: ' + (reason || 'Unknown reason'));
                
                // If not max reconnection attempts, try to reconnect
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    // Use fixed 30-second interval to match Windows app ConnectionSettings.cs
                    const delay = RECONNECT_INTERVAL;
                    console.log(`Scheduling reconnection attempt ${reconnectAttempts + 1} in ${delay/1000}s`);
                    
                    // Store current remotePcId for reconnection
                    const currentRemotePcId = remotePcId;
                    
                    setTimeout(() => {
                        reconnectAttempts++;
                        
                        // Store a reference to viewerSocket before disconnecting
                        const socketRef = viewerSocket;
                        
                        // Check if we still have a valid socket before trying to emit
                        if (socketRef && socketRef.connected) {
                            // Check if device is still online before attempting to reconnect
                            socketRef.emit('device-status-request', {
                                remotePcId: currentRemotePcId
                            });
                        } else {
                            // If socket is gone, try to reconnect directly
                            initViewer(currentRemotePcId);
                        }
                    }, delay);
                }
            },
            onError: (error) => {
                console.error('WebRTC error:', error);
                showError(error);
                
                // Reset connecting state
                isConnecting = false;
                
                // Try to refetch device status
                viewerSocket.emit('device-status-request', {
                    remotePcId: remotePcId
                });
            }
        });
        
        // Send connection request to initiate the WebRTC process
        try {
            const response = await fetch(`/api/devices/${remotePcId}/connect`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${Auth.getToken()}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error('Server response error:', errorText);
                throw new Error(`Failed to initiate connection: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error(data.message || 'Failed to initiate connection');
            }
            
            // Send request-connection via socket to initiate WebRTC connection
            // Format matches Windows app expectation
            viewerSocket.emit('message', {
                type: 'connect',
                from: clientId,
                to: remotePcId
            });
            
            // Connect WebRTC client
            await rtcClient.connect(remotePcId);
            
            // Request device status update
            viewerSocket.emit('device-status-request', {
                remotePcId: remotePcId
            });
        } catch (apiError) {
            console.error('API connection error:', apiError);
            showError(apiError.message || 'Failed to initiate connection');
            
            // For testing, we'll try to continue with WebRTC connection anyway
            try {
                // Send request-connection via socket to initiate WebRTC connection
                // Format matches Windows app expectation
                viewerSocket.emit('message', {
                    type: 'connect',
                    from: clientId,
                    to: remotePcId
                });
                
                // Connect WebRTC client
                await rtcClient.connect(remotePcId);
                
                // Request device status update
                viewerSocket.emit('device-status-request', {
                    remotePcId: remotePcId
                });
            } catch (fallbackError) {
                console.error('Fallback connection error:', fallbackError);
                showError('Connection failed: ' + (fallbackError.message || 'Unknown error'));
                
                // Reset connecting state
                isConnecting = false;
            }
        }
    } catch (error) {
        console.error('Error connecting to device:', error);
        showError(error.message || 'Failed to connect to device');
        
        // Reset connecting state
        isConnecting = false;
    }
}

/**
 * Fetch device information from the API
 * @param {string} remotePcId - Device ID
 */
async function fetchDeviceInfo(remotePcId) {
    try {
        // CRITICAL FIX: Add validation to prevent undefined remotePcId
        if (!remotePcId) {
            console.error('Cannot fetch device info: remotePcId is undefined');
            
            // Update UI with placeholder information
            const deviceName = document.getElementById('device-name');
            if (deviceName) deviceName.textContent = 'Unknown Device';
            updateDeviceStatus('unknown');
            return;
        }
        
        const response = await fetch(`/api/devices/${remotePcId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${Auth.getToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            // For testing purposes, create a fallback device info object
            console.warn(`Failed to fetch device info, status: ${response.status}. Using fallback.`);
            
            // Find device in local cache
            const device = devices.find(d => d.remotePcId === remotePcId);
            if (device) {
                // Update UI with cached device information
                const deviceName = document.getElementById('device-name');
                if (deviceName) deviceName.textContent = device.systemName || 'Unknown Device';
                updateDeviceStatus(device.status || 'unknown');
                return;
            }
            
            // If not in cache, use hardcoded fallback
            const deviceName = document.getElementById('device-name');
            if (deviceName) deviceName.textContent = `Device ${remotePcId}`;
            updateDeviceStatus('unknown');
            return;
        }
        
        const data = await response.json();
        
        if (!data.success || !data.device) {
            throw new Error(data.message || 'Failed to fetch device information');
        }
        
        // Update UI with device information
        const deviceName = document.getElementById('device-name');
        if (deviceName) deviceName.textContent = data.device.systemName || `Device ${remotePcId}`;
        updateDeviceStatus(data.device.status || 'unknown');
    } catch (error) {
        console.error('Error fetching device information:', error);
        // Don't throw, just log and continue with fallback
    }
}

/**
 * Update device status indicator
 * @param {string} status - Device status
 */
function updateDeviceStatus(status) {
    try {
        const statusElement = document.getElementById('device-status');
        if (!statusElement) return;
        
        // Ensure status is valid
        if (!status) status = 'unknown';
        
        // Remove all status classes
        statusElement.classList.remove('online', 'offline', 'idle', 'unknown');
        
        // Add appropriate class
        statusElement.classList.add(status);
        
        // Update text
        statusElement.textContent = capitalizeFirstLetter(status);
    } catch (error) {
        console.error('Error updating device status:', error);
    }
}

/**
 * Show connection error
 * @param {string} message - Error message
 */
function showError(message) {
    try {
        // Hide loading indicator
        const loadingIndicator = document.getElementById('loading-indicator');
        if (loadingIndicator) loadingIndicator.classList.add('hidden');
        
        // Show error message
        const errorElement = document.getElementById('connection-error');
        if (errorElement) errorElement.classList.remove('hidden');
        
        // Update error message
        const errorMessage = document.getElementById('error-message');
        if (errorMessage) errorMessage.textContent = message;
        
        // Reset connecting state
        isConnecting = false;
    } catch (error) {
        console.error('Error displaying connection error:', error);
    }
}

/**
 * Start session timer
 */
function startSessionTimer() {
    try {
        // Set session start time
        sessionStartTime = new Date();
        
        // Update timer display
        updateSessionTime();
        
        // Start timer interval
        sessionTimer = setInterval(updateSessionTime, 1000);
    } catch (error) {
        console.error('Error starting session timer:', error);
    }
}

/**
 * Update session time display
 */
function updateSessionTime() {
    try {
        if (!sessionStartTime) return;
        
        const now = new Date();
        const diff = now - sessionStartTime;
        
        // Calculate hours, minutes, seconds
        const hours = Math.floor(diff / 3600000);
        const minutes = Math.floor((diff % 3600000) / 60000);
        const seconds = Math.floor((diff % 60000) / 1000);
        
        // Format time string
        const timeString = [
            hours.toString().padStart(2, '0'),
            minutes.toString().padStart(2, '0'),
            seconds.toString().padStart(2, '0')
        ].join(':');
        
        // Update display
        const sessionTime = document.getElementById('session-time');
        if (sessionTime) sessionTime.textContent = timeString;
    } catch (error) {
        console.error('Error updating session time:', error);
    }
}

/**
 * Toggle remote control
 */
function toggleControl() {
    try {
        if (!rtcClient) return;
        
        controlEnabled = !controlEnabled;
        
        if (controlEnabled) {
            rtcClient.enableControls();
        } else {
            rtcClient.disableControls();
        }
        
        // Update button state
        updateControlButtonState();
    } catch (error) {
        console.error('Error toggling control:', error);
    }
}

/**
 * Update control button state
 */
function updateControlButtonState() {
    try {
        const button = document.getElementById('control-toggle');
        if (!button) return;
        
        if (controlEnabled) {
            button.classList.add('active');
            button.title = 'Disable Remote Control';
        } else {
            button.classList.remove('active');
            button.title = 'Enable Remote Control';
        }
    } catch (error) {
        console.error('Error updating control button state:', error);
    }
}

/**
 * Toggle fullscreen mode
 */
function toggleFullscreen() {
    try {
        const container = document.getElementById('screen-container');
        if (!container) return;
        
        if (!document.fullscreenElement) {
            // Enter fullscreen
            if (container.requestFullscreen) {
                container.requestFullscreen();
            } else if (container.webkitRequestFullscreen) {
                container.webkitRequestFullscreen();
            } else if (container.msRequestFullscreen) {
                container.msRequestFullscreen();
            }
            
            // Update button
            const fullscreenButton = document.getElementById('fullscreen-button');
            if (fullscreenButton) {
                fullscreenButton.innerHTML = '<i class="fas fa-compress"></i>';
                fullscreenButton.title = 'Exit Fullscreen';
            }
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
            
            // Update button
            const fullscreenButton = document.getElementById('fullscreen-button');
            if (fullscreenButton) {
                fullscreenButton.innerHTML = '<i class="fas fa-expand"></i>';
                fullscreenButton.title = 'Fullscreen';
            }
        }
    } catch (error) {
        console.error('Error toggling fullscreen:', error);
    }
}

/**
 * Refresh connection
 */
function refreshConnection() {
    try {
        const retryButton = document.getElementById('retry-button');
        if (!retryButton) return;
        
        // CRITICAL FIX: Use consistent attribute name for remotePcId
        const remotePcId = retryButton.getAttribute('data-remote-pc-id');
        if (remotePcId) {
            // Reset reconnection attempts
            reconnectAttempts = 0;
            
            // Disconnect any existing connections
            disconnectFromDevice();
            
            // Reinitialize viewer
            initViewer(remotePcId);
        } else {
            console.error('Cannot refresh connection: Missing remotePcId on retry button');
        }
    } catch (error) {
        console.error('Error refreshing connection:', error);
    }
}

/**
 * Disconnect from device
 */
function disconnectFromDevice() {
    try {
        // Stop connection monitoring
        stopConnectionMonitoring();
        
        // Make a safe local copy of rtcClient and viewerSocket before nullifying them
        const rtcClientRef = rtcClient;
        const viewerSocketRef = viewerSocket;
        
        // Clear the global references first
        rtcClient = null;
        viewerSocket = null;
        
        // Disconnect WebRTC if active
        if (rtcClientRef) {
            try {
                rtcClientRef.disconnect();
            } catch (error) {
                console.warn('Error disconnecting WebRTC client:', error);
            }
        }
        
        // Disconnect socket if active
        if (viewerSocketRef) {
            try {
                viewerSocketRef.disconnect();
            } catch (error) {
                console.warn('Error disconnecting socket:', error);
            }
        }
        
        // Clear session timer if active
        if (sessionTimer) {
            clearInterval(sessionTimer);
            sessionTimer = null;
        }
        
        // Reset session start time
        sessionStartTime = null;
        
        // Reset reconnection attempts
        reconnectAttempts = 0;
        
        // Reset connecting state
        isConnecting = false;
        
        // Reset session time display
        const sessionTime = document.getElementById('session-time');
        if (sessionTime) sessionTime.textContent = '00:00:00';
        
        // Reset connection status
        const connectionStatus = document.getElementById('connection-status');
        if (connectionStatus) connectionStatus.textContent = 'Disconnected';
    } catch (error) {
        console.error('Error disconnecting from device:', error);
    }
}

// Handle page unload
window.addEventListener('beforeunload', function() {
    // Disconnect from device if connected
    disconnectFromDevice();
});