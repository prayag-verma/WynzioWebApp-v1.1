/**
 * Main application logic for Wynzio
 */
const App = (function() {
    // Import configuration
    const config = typeof AppConfig !== 'undefined' ? AppConfig : {
        apiUrl: '/api',
        authTokenKey: 'wynzio_auth_token',
        userDataKey: 'wynzio_user_data',
        tokenRefreshInterval: 5 * 60 * 1000, // 5 minutes in milliseconds
        loginPath: '/login',
        dashboardPath: '/dashboard'
    };
    
    // Application state
    let state = {
        isAuthenticated: false,
        user: null,
        loading: false,
        tokenRefreshTimer: null,
        sidebarCollapsed: false,
        refreshInProgress: false
    };
    
    /**
     * Initialize application
     */
    async function init() {
        try {
            // Check authentication status
            await checkAuth();
            
            // If authenticated, refresh user data (but don't block UI)
            if (state.isAuthenticated && Auth.refreshCurrentUser) {
                refreshData(false);
            }
            
            // Initialize event listeners
            initEventListeners();
            
            // Show user information
            updateUserInfo();
            
            // Set up token refresh interval
            setupTokenRefresh();
        } catch (error) {
            console.error('App initialization error:', error);
            // If there's a critical error, clear auth data and redirect to login
            if (typeof Auth !== 'undefined') {
                Auth.logout();
                window.location.href = config.loginPath;
            }
        }
    }
    
    /**
     * Set up token refresh interval
     */
    function setupTokenRefresh() {
        // Clear any existing interval
        if (state.tokenRefreshTimer) {
            clearInterval(state.tokenRefreshTimer);
        }
        
        // Set up new interval if authenticated
        if (state.isAuthenticated) {
            state.tokenRefreshTimer = setInterval(async () => {
                try {
                    const isValid = await Auth.validateToken();
                    
                    if (isValid) {
                        // Refresh user data periodically to ensure it's up to date
                        // But don't refresh data if a refresh is already in progress
                        if (Auth.refreshCurrentUser && !state.refreshInProgress) {
                            refreshData(false);
                        }
                    } else {
                        // If token becomes invalid, redirect to login
                        Auth.logout();
                        window.location.href = config.loginPath;
                    }
                } catch (error) {
                    console.error('Token refresh error:', error);
                }
            }, config.tokenRefreshInterval);
        }
    }
    
    /**
     * Check if user is authenticated
     */
    async function checkAuth() {
        try {
            const isLoggedIn = await Auth.isLoggedIn(false); // Don't verify with server on every page load
            
            if (isLoggedIn) {
                state.isAuthenticated = true;
                state.user = Auth.getCurrentUser();
            } else {
                state.isAuthenticated = false;
                state.user = null;
                
                // If not on login page, redirect
                if (!window.location.pathname.includes(config.loginPath)) {
                    window.location.href = config.loginPath;
                }
            }
        } catch (error) {
            console.error('Authentication check error:', error);
            state.isAuthenticated = false;
            state.user = null;
        }
    }
    
    /**
     * Initialize event listeners
     */
    function initEventListeners() {
        const menuItems = document.querySelectorAll('.menu-item');
        const logoutBtn = document.getElementById('logout-btn');
        const dropdownLogoutBtn = document.getElementById('dropdown-logout-btn');
        
        // Menu item click
        if (menuItems) {
            menuItems.forEach(item => {
                item.addEventListener('click', function() {
                    // Remove active class from all items
                    menuItems.forEach(i => i.classList.remove('active'));
                    
                    // Add active class to clicked item
                    this.classList.add('active');
                    
                    // Update page title
                    const page = this.getAttribute('data-page');
                    const pageTitle = document.getElementById('page-title');
                    
                    if (pageTitle) {
                        pageTitle.textContent = page.charAt(0).toUpperCase() + page.slice(1);
                    }
                });
            });
        }
        
        // Logout buttons
        if (logoutBtn) {
            logoutBtn.addEventListener('click', function(e) {
                e.preventDefault();
                Auth.handleLogout();
            });
        }
        
        if (dropdownLogoutBtn) {
            dropdownLogoutBtn.addEventListener('click', function(e) {
                e.preventDefault();
                Auth.handleLogout();
            });
        }
        
        // Add refresh data button to user dropdown
        const userDropdownMenu = document.getElementById('user-dropdown-menu');
        if (userDropdownMenu) {
            // Check if refresh button already exists
            if (!document.getElementById('refresh-data-btn')) {
                const refreshBtn = document.createElement('a');
                refreshBtn.href = '#';
                refreshBtn.className = 'dropdown-item';
                refreshBtn.id = 'refresh-data-btn';
                refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh Data';
                
                // Insert before logout section
                const divider = userDropdownMenu.querySelector('.dropdown-divider');
                if (divider) {
                    userDropdownMenu.insertBefore(refreshBtn, divider);
                } else {
                    userDropdownMenu.appendChild(refreshBtn);
                }
                
                // Add event listener
                refreshBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    refreshData(true);
                    
                    // Close dropdown
                    userDropdownMenu.classList.remove('show');
                });
            }
        }
        
        // Handle user dropdown toggle
        const userDropdown = document.getElementById('user-dropdown');
        if (userDropdown && userDropdownMenu) {
            userDropdown.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                userDropdownMenu.classList.toggle('show');
            });
            
            // Close dropdown when clicking outside
            document.addEventListener('click', function(e) {
                if (userDropdownMenu.classList.contains('show') && 
                    !userDropdown.contains(e.target)) {
                    userDropdownMenu.classList.remove('show');
                }
            });
        }
        
        // Hide elements based on role
        const currentUser = Auth.getCurrentUser();
        if (currentUser) {
            const menuUsers = document.getElementById('menu-users');
            
            // Show users menu only to admin
            if (menuUsers && currentUser.role !== 'admin') {
                menuUsers.classList.add('hidden');
            }
        }
    }
    
    /**
     * Update user information in the UI
     */
    function updateUserInfo() {
        const currentUser = Auth.getCurrentUser();
        
        if (currentUser) {
            // Update profile avatar in header
            const profileAvatar = document.getElementById('profile-avatar');
            
            if (profileAvatar) {
                if (currentUser.firstName && currentUser.lastName) {
                    const initials = Utils.getInitials(`${currentUser.firstName} ${currentUser.lastName}`);
                    profileAvatar.innerHTML = initials;
                    profileAvatar.style.backgroundColor = Utils.stringToColor(currentUser.username);
                } else {
                    profileAvatar.innerHTML = '<i class="fas fa-user"></i>';
                }
            }
            
            // Update dropdown user name
            const dropdownUserName = document.getElementById('user-dropdown-name');
            
            if (dropdownUserName) {
                dropdownUserName.textContent = currentUser.firstName || currentUser.username;
            }
        }
    }
    
    /**
     * Force refresh all user data
     * @param {boolean} showIndicator - Whether to show a loading indicator
     */
    async function refreshData(showIndicator = true) {
        if (state.refreshInProgress) {
            return false;
        }
        
        state.refreshInProgress = true;
        
        // Show loading indicator if requested
        if (showIndicator) {
            const refreshBtn = document.getElementById('refresh-data-btn');
            if (refreshBtn) {
                const icon = refreshBtn.querySelector('i');
                icon.classList.remove('fa-sync-alt');
                icon.classList.add('fa-spinner');
                icon.classList.add('fa-spin');
            }
        }
        
        try {
            if (Auth.refreshCurrentUser) {
                state.user = await Auth.refreshCurrentUser();
                updateUserInfo();
            }
        } catch (error) {
            console.error('Error refreshing data:', error);
        } finally {
            state.refreshInProgress = false;
            
            // Reset icon after 1 second if showing indicator
            if (showIndicator) {
                setTimeout(() => {
                    const refreshBtn = document.getElementById('refresh-data-btn');
                    if (refreshBtn) {
                        const icon = refreshBtn.querySelector('i');
                        icon.classList.remove('fa-spinner');
                        icon.classList.remove('fa-spin');
                        icon.classList.add('fa-sync-alt');
                    }
                    
                    // Show a success notification
                    if (typeof Utils !== 'undefined' && Utils.showNotification) {
                        Utils.showNotification('Data refreshed successfully', 'success', 2000);
                    }
                }, 1000);
            }
        }
        
        return true;
    }
    
    // Public API
    return {
        init,
        checkAuth,
        updateUserInfo,
        refreshData
    };
})();