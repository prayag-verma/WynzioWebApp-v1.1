/**
 * Authentication Module
 * Handles user authentication, session management, and permission checking
 */
const Auth = (function() {
    // Private variables
    let _currentUser = null;
    let _token = null;
    let _permissions = [];
    let _tokenValidated = false;
    let _validationInProgress = false;
    let _lastValidationTime = 0;
    
    // Import configuration
    const config = typeof AppConfig !== 'undefined' ? AppConfig : {
        apiUrl: '/api',
        authTokenKey: 'wynzio_auth_token',
        userDataKey: 'wynzio_user_data',
        clientIdKey: 'wynzio_client_id',
        loginPath: '/login',
        dashboardPath: '/dashboard',
        validationTimeout: 30000 // 30 seconds between validations
    };
    
    /**
     * Initialize the authentication module
     */
    function init() {
        // Check for existing token
        _token = localStorage.getItem(config.authTokenKey);
        const userJson = localStorage.getItem(config.userDataKey);
        
        if (_token && userJson) {
            try {
                _currentUser = JSON.parse(userJson);
                _permissions = _currentUser.permissions || [];
                
                // Consider token initially valid if we have it in localStorage
                // We'll validate it properly when needed
                _tokenValidated = true;
            } catch (error) {
                console.error('Error parsing stored user data:', error);
                clearAuthData();
            }
        }
    }
    
    /**
     * Clear authentication data from memory and storage
     */
    function clearAuthData() {
        _token = null;
        _currentUser = null;
        _permissions = [];
        _tokenValidated = false;
        _lastValidationTime = 0;
        
        localStorage.removeItem(config.authTokenKey);
        localStorage.removeItem(config.userDataKey);
        
        // Don't clear Web client ID on logout - keep persistent Web client ID
        // localStorage.removeItem(config.clientIdKey);
    }

    /**
     * Generate or retrieve Web client ID for WebSocket connections
     * @returns {string} Web Client ID
     */
    function getClientId() {
        // Check if we already have a client ID in localStorage with new key name for Windows app
        let storedClientId = localStorage.getItem('webClientId');
        
        // If not found with new key, check old key for backward compatibility
        if (!storedClientId) {
            storedClientId = localStorage.getItem(config.clientIdKey);
            // If found with old key, migrate to new key for future use
            if (storedClientId) {
                localStorage.setItem('webClientId', storedClientId);
            }
        }
        
        // If still not found, generate a new client ID
        if (!storedClientId) {
            storedClientId = 'web-client-' + Date.now();
            localStorage.setItem('webClientId', storedClientId);
            console.log('Created new client ID:', storedClientId);
        }
        
        return storedClientId;
    }
    
    /**
     * Create ripple effect on button
     * @param {Element} button - Button element
     * @param {Event} event - Click event
     */
    function createRipple(button, event) {
        const circle = document.createElement('span');
        const diameter = Math.max(button.clientWidth, button.clientHeight);
        const radius = diameter / 2;
        
        // Get button position
        const rect = button.getBoundingClientRect();
        
        // Calculate ripple position
        circle.style.width = circle.style.height = `${diameter}px`;
        circle.style.left = `${event.clientX - rect.left - radius}px`;
        circle.style.top = `${event.clientY - rect.top - radius}px`;
        
        // Add ripple class
        circle.classList.add('ripple');
        
        // Remove existing ripples
        const ripple = button.querySelector('.ripple');
        if (ripple) {
            ripple.remove();
        }
        
        // Add ripple to button
        button.appendChild(circle);
        
        // Remove ripple after animation
        setTimeout(() => {
            circle.remove();
        }, 600);
    }
    
    /**
     * Initialize login page functionality
     */
    function initLogin() {
        const loginForm = document.getElementById('login-form');
        const loginButton = document.getElementById('login-button');
        const loginError = document.getElementById('login-error');
        const togglePassword = document.getElementById('toggle-password');
        const password = document.getElementById('password');
        
        if (togglePassword && password) {
            togglePassword.addEventListener('click', function() {
                const isPasswordVisible = password.type === 'text';
                password.type = isPasswordVisible ? 'password' : 'text';
                
                togglePassword.classList.toggle('fa-eye');
                togglePassword.classList.toggle('fa-eye-slash');
            });
        }
        
        if (loginForm) {
            loginForm.addEventListener('submit', function(event) {
                event.preventDefault();
                
                // Clear previous errors
                if (loginError) {
                    loginError.classList.add('hidden');
                    loginError.textContent = '';
                }
                
                // Show loading indicator on button
                const spinner = loginButton.querySelector('.fa-spinner');
                const buttonText = loginButton.querySelector('span');
                spinner.classList.remove('hidden');
                buttonText.textContent = 'Signing in...';
                loginButton.disabled = true;
                
                // Create ripple effect on button
                createRipple(loginButton, event);
                
                // Get form data
                const username = document.getElementById('username').value;
                const password = document.getElementById('password').value;
                const rememberMe = document.getElementById('remember-me').checked;
                
                // Call login API
                login(username, password, rememberMe)
                    .then(response => {
                        if (response.success) {
                            // Set token as validated
                            _tokenValidated = true;
                            _lastValidationTime = Date.now();
                            
                            // Generate a new client ID for this session if needed
                            getClientId();
                            
                            // Redirect to dashboard after a short delay
                            setTimeout(() => {
                                window.location.href = config.dashboardPath;
                            }, 1000);
                        } else {
                            // Show error
                            if (loginError) {
                                loginError.textContent = response.message || 'Login failed. Please check your credentials.';
                                loginError.classList.remove('hidden');
                            }
                            
                            // Reset button
                            spinner.classList.add('hidden');
                            buttonText.textContent = 'Sign In';
                            loginButton.disabled = false;
                        }
                    })
                    .catch(error => {
                        console.error('Login error:', error);
                        if (loginError) {
                            loginError.textContent = 'An error occurred during login. Please try again.';
                            loginError.classList.remove('hidden');
                        }
                        
                        // Reset button
                        spinner.classList.add('hidden');
                        buttonText.textContent = 'Sign In';
                        loginButton.disabled = false;
                    });
            });
        }
    }
    
    /**
     * Attempt to login with credentials
     * @param {string} username Username
     * @param {string} password Password
     * @param {boolean} rememberMe Whether to remember the session
     * @returns {Promise} Promise resolving to login result
     */
    async function login(username, password, rememberMe = false) {
        try {
            const response = await fetch(`${config.apiUrl}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache'
                },
                body: JSON.stringify({ username, password, rememberMe })
            });
            
            const data = await response.json();
            
            if (data.success && data.token) {
                // Store token and user data
                _token = data.token;
                _currentUser = data.user;
                _permissions = data.user.permissions || [];
                _tokenValidated = true;
                _lastValidationTime = Date.now();
                
                localStorage.setItem(config.authTokenKey, _token);
                localStorage.setItem(config.userDataKey, JSON.stringify(_currentUser));
            }
            
            return data;
        } catch (error) {
            console.error('Login request failed:', error);
            return { 
                success: false, 
                message: 'Network error. Please check your connection and try again.' 
            };
        }
    }
    
    /**
     * Handle logout with transition overlay
     */
    async function handleLogout() {
        // Create a logout overlay
        const logoutOverlay = document.createElement('div');
        logoutOverlay.className = 'logout-overlay';
        logoutOverlay.innerHTML = `
            <div class="logout-content">
                <div class="logout-spinner">
                    <i class="fas fa-spinner fa-spin fa-3x"></i>
                </div>
                <div class="logout-text">Logging out...</div>
            </div>
        `;
        document.body.appendChild(logoutOverlay);
        
        try {
            // Wait briefly for animation (1 second)
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Perform actual logout
            await logout();
            
            // Redirect to login page
            window.location.href = config.loginPath;
        } catch (error) {
            console.error('Error during logout:', error);
            // Still redirect to login on error
            window.location.href = config.loginPath;
        }
    }
    
    /**
     * Log out the current user
     * @returns {Promise} Promise that resolves when logout is complete
     */
    async function logout() {
        // Try to invalidate token on server if one exists
        if (_token) {
            try {
                await fetch(`${config.apiUrl}/auth/logout`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${_token}`,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'no-cache'
                    }
                });
            } catch (err) {
                console.error('Error during server logout:', err);
            }
        }
        
        // Clear token and user data
        clearAuthData();
        
        return Promise.resolve();
    }
    
    /**
     * Validate authentication token with server
     * @returns {Promise<boolean>} Promise resolving to token validity
     */
    async function validateToken() {
        if (!_token) {
            return false;
        }
        
        // If token was recently validated, skip validation to prevent loops
        const now = Date.now();
        if (_tokenValidated && (now - _lastValidationTime < config.validationTimeout)) {
            return true;
        }
        
        // Prevent multiple simultaneous validation requests
        if (_validationInProgress) {
            return new Promise(resolve => {
                const checkInterval = setInterval(() => {
                    if (!_validationInProgress) {
                        clearInterval(checkInterval);
                        resolve(_tokenValidated);
                    }
                }, 100);
            });
        }
        
        _validationInProgress = true;
        
        try {
            const response = await fetch(`${config.apiUrl}/auth/validate`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${_token}`,
                    'Cache-Control': 'no-cache'
                }
            });
            
            if (!response.ok) {
                _tokenValidated = false;
                _validationInProgress = false;
                return false;
            }
            
            const data = await response.json();
            _tokenValidated = data.valid === true;
            _lastValidationTime = Date.now();
            _validationInProgress = false;
            
            if (!_tokenValidated) {
                clearAuthData();
            }
            
            return _tokenValidated;
        } catch (error) {
            console.error('Token validation error:', error);
            _tokenValidated = false;
            _validationInProgress = false;
            clearAuthData();
            return false;
        }
    }
    
    /**
     * Check if a user is logged in and has a valid token
     * @param {boolean} verifyWithServer Whether to verify token with server
     * @returns {Promise<boolean>|boolean} True if logged in with valid token
     */
    async function isLoggedIn(verifyWithServer = false) {
        const hasToken = !!_token && !!_currentUser;
        
        if (!hasToken) {
            return false;
        }
        
        if (verifyWithServer) {
            return await validateToken();
        }
        
        return hasToken;
    }
    
    /**
     * Get the current user object
     * @returns {Object|null} Current user or null if not logged in
     */
    function getCurrentUser() {
        return _currentUser;
    }
    
    /**
     * Refresh current user data from server
     * @returns {Promise<Object|null>} Updated user data or null on error
     */
    async function refreshCurrentUser() {
        if (!_token) {
            return null;
        }
        
        try {
            const response = await fetch(`${config.apiUrl}/users/me`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${_token}`,
                    'Cache-Control': 'no-cache'
                }
            });
            
            if (!response.ok) {
                return null;
            }
            
            const data = await response.json();
            
            if (data.success && data.data) {
                // Update user data
                _currentUser = data.data;
                _permissions = data.data.permissions || [];
                
                // Update localStorage
                localStorage.setItem(config.userDataKey, JSON.stringify(_currentUser));
                
                return _currentUser;
            }
            
            return null;
        } catch (error) {
            console.error('Error refreshing user data:', error);
            return null;
        }
    }
    
    /**
     * Get the current authentication token
     * @returns {string|null} Current token or null if not logged in
     */
    function getToken() {
        return _token;
    }
    
    /**
     * Check if current user has a specific permission
     * @param {string} permission Permission to check
     * @returns {boolean} True if user has permission, false otherwise
     */
    function hasPermission(permission) {
        return _permissions.includes(permission);
    }
    
    /**
     * Check if current user has a specific role
     * @param {string} role Role to check
     * @returns {boolean} True if user has role, false otherwise
     */
    function hasRole(role) {
        return _currentUser && _currentUser.role === role;
    }
    
    /**
     * Protect a page - redirect to login if not authenticated
     * @returns {Promise<boolean>} Whether user is authenticated
     */
    async function protectPage() {
        // First check if we're already on the login page
        if (window.location.pathname.includes(config.loginPath)) {
            return true;
        }
        
        // Check if token was already validated recently
        const now = Date.now();
        if (_tokenValidated && _token && (now - _lastValidationTime < config.validationTimeout)) {
            // If we have a valid token that was validated recently, no need to verify again
            return true;
        }
        
        // Verify authentication with server
        const isAuthenticated = await isLoggedIn(true);
        
        if (!isAuthenticated) {
            // Redirect to login, don't allow any dashboard code to run
            window.location.replace(config.loginPath);
            return false;
        }
        
        return true;
    }
    
    // Initialize the auth module when the script loads
    init();
    
    // Public API
    return {
        initLogin,
        login,
        logout,
        handleLogout,
        isLoggedIn,
        validateToken,
        getCurrentUser,
        refreshCurrentUser,
        getToken,
        getClientId,
        hasPermission,
        hasRole,
        protectPage,
        createRipple
    };
})();