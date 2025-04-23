/**
 * device-manager.js
 * Handles device management and remote viewer functionality
 * Modified to align with Windows app expectations
 */

// Global variables
let devices = [];
let rtcClient = null;
let viewerSocket = null;
let sessionStartTime = null;
let sessionTimer = null;
let controlEnabled = true;
let clientId = 'web-client-' + Date.now(); // Unique client ID for this web client

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
        const deviceCard = document.createElement('div');
        deviceCard.className = `device-card ${device.status || 'unknown'}`;
        deviceCard.dataset.deviceId = device.deviceId;
        
        // Format last seen time
        const lastSeen = device.lastSeen ? formatTimeAgo(new Date(device.lastSeen)) : 'Never';
        
        // Create device card content
        deviceCard.innerHTML = `
            <div class="device-info">
                <div class="device-name">
                    <h4>${device.systemName || 'Unknown Device'}</h4>
                    <span class="device-id">${device.deviceId}</span>
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
            connectToDevice(device.deviceId);
        });
        
        const detailsBtn = deviceCard.querySelector('.view-details-btn');
        detailsBtn.addEventListener('click', () => {
            viewDeviceDetails(device.deviceId);
        });
        
        // Add to list
        deviceList.appendChild(deviceCard);
    });
}

/**
 * Connect to device
 */
function connectToDevice(deviceId) {
    // Show remote viewer section
    showRemoteViewerSection();
    
    // Initialize viewer with device ID - assume control will be granted automatically
    document.getElementById('control-toggle').classList.add('active');
    controlEnabled = true;
    
    // Initialize viewer
    initViewer(deviceId);
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
function viewDeviceDetails(deviceId) {
    // Implement device details modal or page
    // For now, just open connection page
    connectToDevice(deviceId);
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
        // Connect to Socket.IO server with client ID matching Windows app expectations
        const socket = io('', {
            query: {
                type: 'dashboard',
                clientId: clientId // Use the globally defined client ID
            },
            auth: {
                token: Auth.getToken()
            }
        });
        
        // Listen for device status updates
        socket.on('device-status-update', (data) => {
            // Find device in list
            const deviceIndex = devices.findIndex(d => d.deviceId === data.deviceId);
            
            if (deviceIndex !== -1) {
                // Update device status
                devices[deviceIndex].status = data.status;
                devices[deviceIndex].lastSeen = data.timestamp;
                
                // Update UI if already rendered
                const deviceCard = document.querySelector(`.device-card[data-device-id="${data.deviceId}"]`);
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
            // Update devices
            devices = deviceList;
            
            // Filter and render devices
            filterDevices();
        });
        
        // Listen for connection error
        socket.on('connection-error', (data) => {
            console.error('Connection error:', data.error);
            showError(data.error || 'Failed to connect to device');
        });
        
        // Listen for socket disconnect
        socket.on('disconnect', () => {
            console.log('Socket disconnected');
        });
        
        // Listen for socket reconnect
        socket.on('connect', () => {
            console.log('Socket reconnected');
            
            // Refetch devices
            fetchDevices();
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
                const currentDeviceId = retryButton.getAttribute('data-device-id');
                if (currentDeviceId) {
                    initViewer(currentDeviceId);
                }
            });
        }
    } catch (error) {
        console.error('Error initializing viewer controls:', error);
    }
}

/**
 * Initialize the remote viewer
 * @param {string} deviceId - Device ID to connect to
 */
async function initViewer(deviceId) {
    try {
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
        
        // Store device ID for retry button
        const retryButton = document.getElementById('retry-button');
        if (retryButton) retryButton.setAttribute('data-device-id', deviceId);
        
        // Disconnect existing connection if any
        disconnectFromDevice();
        
        // Fetch device information
        await fetchDeviceInfo(deviceId);
        
        // Connect to Socket.IO server with consistent client ID
        viewerSocket = io('', {
            query: {
                type: 'dashboard',
                clientId: clientId
            },
            auth: {
                token: Auth.getToken()
            }
        });
        
        // Wait for socket connection
        await new Promise((resolve, reject) => {
            viewerSocket.on('connect', resolve);
            viewerSocket.on('connect_error', reject);
            viewerSocket.on('error', reject);
            
            // Set timeout for connection
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);
            
            // Clear timeout on connect
            viewerSocket.on('connect', () => clearTimeout(timeout));
        });
        
        // Initialize WebRTC client - MODIFIED TO ALWAYS ENABLE CONTROLS
        rtcClient = WynzioWebRTC.initialize({
            socket: viewerSocket,
            viewerElement: 'screen-view',
            deviceId: deviceId,
            clientId: clientId,
            enableControls: true, // Always enable controls - no permission needed
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
                
                // Start session timer
                startSessionTimer();
                
                // Update control button state - always active
                updateControlButtonState();
            },
            onDisconnected: (reason) => {
                const connectionStatus = document.getElementById('connection-status');
                if (connectionStatus) connectionStatus.textContent = 'Disconnected: ' + (reason || 'Unknown reason');
                
                // Stop session timer
                if (sessionTimer) {
                    clearInterval(sessionTimer);
                    sessionTimer = null;
                }
                
                // Show connection error
                showError('Connection closed: ' + (reason || 'Unknown reason'));
            },
            onError: (error) => {
                console.error('WebRTC error:', error);
                showError(error);
            }
        });
        
        // Send connection request to initiate the WebRTC process
        try {
            const response = await fetch(`/api/devices/${deviceId}/connect`, {
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
            viewerSocket.emit('request-connection', {
                deviceId: deviceId,
                requestId: data.requestId || 'req-' + Date.now()
            });
            
            // Connect WebRTC client
            await rtcClient.connect(deviceId);
            
            // Request device status update
            viewerSocket.emit('device-status-request', {
                deviceId: deviceId
            });
        } catch (apiError) {
            console.error('API connection error:', apiError);
            showError(apiError.message || 'Failed to initiate connection');
            // For testing, we'll try to continue with WebRTC connection anyway
            try {
                // Generate a fallback request ID
                const fallbackRequestId = 'fallback-req-' + Date.now();
                
                // Send request-connection via socket to initiate WebRTC connection
                viewerSocket.emit('request-connection', {
                    deviceId: deviceId,
                    requestId: fallbackRequestId
                });
                
                // Connect WebRTC client
                await rtcClient.connect(deviceId);
                
                // Request device status update
                viewerSocket.emit('device-status-request', {
                    deviceId: deviceId
                });
            } catch (fallbackError) {
                console.error('Fallback connection error:', fallbackError);
                showError('Connection failed: ' + (fallbackError.message || 'Unknown error'));
            }
        }
    } catch (error) {
        console.error('Error connecting to device:', error);
        showError(error.message || 'Failed to connect to device');
    }
}

/**
 * Fetch device information from the API
 * @param {string} deviceId - Device ID
 */
async function fetchDeviceInfo(deviceId) {
    try {
        const response = await fetch(`/api/devices/${deviceId}`, {
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
            const device = devices.find(d => d.deviceId === deviceId);
            if (device) {
                // Update UI with cached device information
                const deviceName = document.getElementById('device-name');
                if (deviceName) deviceName.textContent = device.systemName || 'Unknown Device';
                updateDeviceStatus(device.status || 'unknown');
                return;
            }
            
            // If not in cache, use hardcoded fallback
            const deviceName = document.getElementById('device-name');
            if (deviceName) deviceName.textContent = `Device ${deviceId}`;
            updateDeviceStatus('unknown');
            return;
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.message || 'Failed to fetch device information');
        }
        
        // Update UI with device information
        const deviceName = document.getElementById('device-name');
        if (deviceName) deviceName.textContent = data.device.systemName;
        updateDeviceStatus(data.device.status);
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
        
        const deviceId = retryButton.getAttribute('data-device-id');
        if (deviceId) {
            initViewer(deviceId);
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
        // Disconnect WebRTC if active
        if (rtcClient) {
            rtcClient.disconnect();
            rtcClient = null;
        }
        
        // Disconnect socket if active
        if (viewerSocket) {
            viewerSocket.disconnect();
            viewerSocket = null;
        }
        
        // Clear session timer if active
        if (sessionTimer) {
            clearInterval(sessionTimer);
            sessionTimer = null;
        }
        
        // Reset session start time
        sessionStartTime = null;
        
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