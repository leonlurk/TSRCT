// ==============================================
// TSRCT - World Manager
// Room/World Navigation System
// Phase 3B: IIFE-wrapped -- only WorldManager is exported; the rest is private.
// ==============================================
(function () {

        // ═══════════════════════════════════════════════════════════
        // WORLD MANAGER - Room/World Navigation System
        // ═══════════════════════════════════════════════════════════
        const WorldManager = {
            // CSS lazy loading cache
            cssLoaded: {},

            // Registry of all available rooms
            rooms: {
                remote: {
                    id: 'remote-room',
                    theme: 'gateway',
                    title: 'Remote Desktop',
                    icon: 'monitor',
                    description: 'Control your PC desktop',
                    onOpen: null,
                    onClose: null
                },
                sfcli: {
                    id: 'sfcli-room',
                    theme: 'sfcli',
                    title: 'SF CLI',
                    icon: 'layers',
                    description: 'Salesforce org management',
                    onOpen: async function() {
                        if (typeof loadSfCli === 'function') await loadSfCli();
                        if (typeof sfOnRoomOpen === 'function') sfOnRoomOpen();
                    },
                    onClose: null
                }
            },

            // Currently active room
            activeRoom: null,

            // Room transition duration in ms
            transitionDuration: 400,

            // Lazy load room CSS
            loadRoomCSS(roomKey) {
                // Return cached promise if already loading/loaded
                if (this.cssLoaded[roomKey]) {
                    return this.cssLoaded[roomKey];
                }

                // Create promise for loading this room's CSS
                this.cssLoaded[roomKey] = new Promise((resolve) => {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = `/src/css/rooms/room-${roomKey}.css`;

                    link.onload = () => {
                        console.log(`[WorldManager] CSS loaded: room-${roomKey}.css`);
                        resolve(true);
                    };

                    link.onerror = () => {
                        console.warn(`[WorldManager] CSS failed to load: room-${roomKey}.css`);
                        resolve(false); // Don't block UI if CSS fails
                    };

                    document.head.appendChild(link);
                });

                return this.cssLoaded[roomKey];
            },

            // Open a room by its key
            async open(roomKey) {
                const room = this.rooms[roomKey];
                if (!room) {
                    console.warn(`Room "${roomKey}" not found`);
                    return false;
                }

                const element = $(room.id);
                if (!element) {
                    console.warn(`Room element "${room.id}" not found in DOM`);
                    return false;
                }

                // Close any currently active room first
                if (this.activeRoom && this.activeRoom !== roomKey) {
                    this.close(this.activeRoom, false);
                }

                // Lazy load room-specific CSS
                await this.loadRoomCSS(roomKey);

                // Set the active room
                this.activeRoom = roomKey;

                // Apply theme class if room extends .room
                if (element.classList.contains('room')) {
                    element.classList.add(`theme-${room.theme}`);
                }

                // Show room with animation
                element.classList.add('active');
                element.classList.remove('exiting');

                // Play entrance sound
                if (typeof playSound === 'function') {
                    playSound('mode');
                }

                // Haptic feedback
                if (typeof vibe === 'function') {
                    vibe('tap');
                }

                // Call room-specific open handler
                if (typeof room.onOpen === 'function') {
                    room.onOpen();
                }

                // Track room visit
                this.trackVisit(roomKey);

                console.log(`[WorldManager] Opened room: ${room.title}`);
                return true;
            },

            // Close a room
            close(roomKey, animate = true) {
                const room = this.rooms[roomKey];
                if (!room) return false;

                const element = $(room.id);
                if (!element) return false;

                // Call room-specific close handler
                if (typeof room.onClose === 'function') {
                    room.onClose();
                }

                if (animate) {
                    // Play exit animation
                    element.classList.add('exiting');
                    element.classList.remove('active');

                    // Remove after animation
                    setTimeout(() => {
                        element.classList.remove('exiting');
                        if (element.classList.contains('room')) {
                            element.classList.remove(`theme-${room.theme}`);
                        }
                    }, this.transitionDuration);

                    // Play sound
                    if (typeof playSound === 'function') {
                        playSound('tap');
                    }
                } else {
                    element.classList.remove('active', 'exiting');
                    if (element.classList.contains('room')) {
                        element.classList.remove(`theme-${room.theme}`);
                    }
                }

                if (this.activeRoom === roomKey) {
                    this.activeRoom = null;
                }

                console.log(`[WorldManager] Closed room: ${room.title}`);
                return true;
            },

            // Toggle a room open/closed
            toggle(roomKey) {
                if (this.activeRoom === roomKey) {
                    return this.close(roomKey);
                } else {
                    return this.open(roomKey);
                }
            },

            // Register custom callbacks for a room
            onRoomOpen(roomKey, callback) {
                if (this.rooms[roomKey]) {
                    this.rooms[roomKey].onOpen = callback;
                }
            },

            onRoomClose(roomKey, callback) {
                if (this.rooms[roomKey]) {
                    this.rooms[roomKey].onClose = callback;
                }
            },

            // Track room visits for analytics
            visits: JSON.parse(localStorage.getItem('roomVisits') || '{}'),

            trackVisit(roomKey) {
                if (!this.visits[roomKey]) {
                    this.visits[roomKey] = { count: 0, lastVisit: null };
                }
                this.visits[roomKey].count++;
                this.visits[roomKey].lastVisit = Date.now();
                localStorage.setItem('roomVisits', JSON.stringify(this.visits));
            },

            // Get room stats
            getStats() {
                return {
                    totalVisits: Object.values(this.visits).reduce((sum, r) => sum + r.count, 0),
                    roomStats: this.visits,
                    mostVisited: Object.entries(this.visits)
                        .sort((a, b) => b[1].count - a[1].count)
                        .map(([key]) => key)[0] || null
                };
            },

            // Check if any room is open
            isAnyOpen() {
                return this.activeRoom !== null;
            },

            // Get info about available rooms
            getRoomList() {
                return Object.entries(this.rooms).map(([key, room]) => ({
                    key,
                    title: room.title,
                    theme: room.theme,
                    icon: room.icon,
                    description: room.description,
                    isActive: this.activeRoom === key
                }));
            }
        };

        // Remote Desktop room lifecycle
        WorldManager.onRoomOpen('remote', () => {
            if (window.rdInit) rdInit();
        });
        WorldManager.onRoomClose('remote', () => {
            if (window.rdDisconnect) rdDisconnect();
        });

        // ── Public API (Phase 3B): the singleton everything navigates through ──
        window.WorldManager = WorldManager;

})();

