/**
 * Central configuration for Wynzio application
 */
const AppConfig = (function() {
    // Default configuration
    const defaultConfig = {
        apiUrl: '/api',
        authTokenKey: 'wynzio_auth_token',
        userDataKey: 'wynzio_user_data',
        configKey: 'wynzio_config',
        jwtSecret: process.env.JWT_SECRET || "3f7t9b20e8r143k0b2l10s6d19q74b1p",
        tokenRefreshInterval: 5 * 60 * 1000,
        defaultRedirectAfterLogin: '/dashboard',
        defaultRedirectAfterLogout: '/login',
        loginPath: '/login',
        dashboardPath: '/dashboard',
        
        // API key for remote device authentication
        remoteApiKey: process.env.REMOTE_API_KEY || '3f7a9b25e8d146c0b2f15a6d90e74c8d',
        
        // WebRTC configuration
        webrtc: {
            iceServers: [
                { urls: process.env.STUN_SERVER || "stun:stun.l.google.com:19302" }
            ],
            useDataChannel: true,
            useAudio: false,
            useVideo: true
        },
        
        // Socket.IO connection configuration - updated to match Windows app exactly
        socketIo: {
            path: '/signal', // Changed from '/socket.io' to '/signal' to match Windows app
            pingInterval: parseInt(process.env.SOCKET_PING_INTERVAL || "25000", 10), // 25 seconds - match Windows app
            pingTimeout: parseInt(process.env.SOCKET_PING_TIMEOUT || "20000", 10), // 20 seconds
            sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || "86400000", 10), // 24 hours - match Windows app SessionManager.cs
            reconnectionDelay: parseInt(process.env.RECONNECT_BASE_DELAY || "2000", 10) // 2 seconds - match Windows app
        },
        
        // Device monitoring configuration
        monitoring: {
            heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "60000", 10), // 1 minute
            offlineThreshold: parseInt(process.env.OFFLINE_THRESHOLD || "300000", 10), // 5 minutes - match Windows app
            idleThreshold: parseInt(process.env.IDLE_THRESHOLD || "60000", 10) // 1 minute - match Windows app
        },
        
        // Data storage configuration
        storage: {
            dataDir: process.env.DATA_DIR || "./data",
            deviceDataDir: process.env.DEVICE_DATA_DIR || "./data/devices",
            deviceLogsDir: process.env.DEVICE_LOGS_DIR || "./data/logs",
            healthDataDir: process.env.HEALTH_DATA_DIR || "./data/health"
        }
    };
    
    // If running in browser, expose only client-side config
    if (typeof window !== 'undefined') {
        // Browser environment
        return {
            get: function(key) {
                const config = JSON.parse(localStorage.getItem(defaultConfig.configKey) || '{}');
                return key ? (config[key] || defaultConfig[key]) : { ...defaultConfig, ...config };
            },
            
            set: function(key, value) {
                const config = JSON.parse(localStorage.getItem(defaultConfig.configKey) || '{}');
                config[key] = value;
                localStorage.setItem(defaultConfig.configKey, JSON.stringify(config));
            },
            
            // Client-side constants
            apiUrl: defaultConfig.apiUrl,
            authTokenKey: defaultConfig.authTokenKey,
            userDataKey: defaultConfig.userDataKey,
            configKey: defaultConfig.configKey,
            tokenRefreshInterval: defaultConfig.tokenRefreshInterval,
            defaultRedirectAfterLogin: defaultConfig.defaultRedirectAfterLogin,
            defaultRedirectAfterLogout: defaultConfig.defaultRedirectAfterLogout,
            loginPath: defaultConfig.loginPath,
            dashboardPath: defaultConfig.dashboardPath,
            webrtc: defaultConfig.webrtc,
            socketIo: defaultConfig.socketIo
        };
    } else {
        // Node.js environment
        return {
            ...defaultConfig,
            jwtSecret: process.env.JWT_SECRET || defaultConfig.jwtSecret,
            remoteApiKey: process.env.REMOTE_API_KEY || defaultConfig.remoteApiKey,
            port: process.env.PORT || 3000
        };
    }
})();

// Export the configuration
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppConfig;
}