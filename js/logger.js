// ========== Auto Console Logger ==========

class ConsoleLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 1000; // Keep last 1000 logs
        this.setupInterceptors();
        // Auto-save disabled - use logger.saveNow() to save manually
    }

    setupInterceptors() {
        // Store original console methods
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        const originalInfo = console.info;

        // Intercept console.log
        console.log = (...args) => {
            this.addLog('LOG', args);
            originalLog.apply(console, args);
        };

        // Intercept console.warn
        console.warn = (...args) => {
            this.addLog('WARN', args);
            originalWarn.apply(console, args);
        };

        // Intercept console.error
        console.error = (...args) => {
            this.addLog('ERROR', args);
            originalError.apply(console, args);
        };

        // Intercept console.info
        console.info = (...args) => {
            this.addLog('INFO', args);
            originalInfo.apply(console, args);
        };
    }

    addLog(type, args) {
        const timestamp = new Date().toISOString();
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, null, 2);
                } catch (e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        this.logs.push({
            timestamp,
            type,
            message
        });

        // Keep only last N logs
        if (this.logs.length > this.maxLogs) {
            this.logs = this.logs.slice(-this.maxLogs);
        }
    }

    formatLogs() {
        return this.logs.map(log =>
            `[${log.timestamp}] [${log.type}] ${log.message}`
        ).join('\n');
    }

    async saveLogs() {
        try {
            const logContent = this.formatLogs();

            // Send to server to save
            const response = await fetch('/api/save-log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: logContent,
                    timestamp: new Date().toISOString()
                })
            });

            if (response.ok) {
                console.info('✅ Logs saved successfully');
            } else {
                console.error('❌ Failed to save logs');
            }
        } catch (error) {
            // Don't log this error to avoid infinite loop
            console.error('❌ Error saving logs:', error);
        }
    }

    // Manual save method (call when needed)
    saveNow() {
        console.info('💾 Saving logs on demand...');
        return this.saveLogs();
    }

    clearLogs() {
        this.logs = [];
        console.info('🗑️ Logs cleared');
    }

    downloadLogs() {
        const logContent = this.formatLogs();
        const blob = new Blob([logContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `console-log-${new Date().toISOString().replace(/:/g, '-')}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Auto-save to server after Dijkstra completes
    autoSaveAfterDijkstra() {
        // Check if last log indicates Dijkstra completion
        if (this.logs.length === 0) return;

        const lastLog = this.logs[this.logs.length - 1];

        // Check for completion indicators
        if (lastLog.message.includes('✅ Path found') ||
            lastLog.message.includes('❌ No path found') ||
            lastLog.message.includes('Path found (')) {

            console.log('🔍 Dijkstra completed - auto-saving logs...');

            // Save to server
            this.saveLogs();

            // Also auto-download if enabled
            if (window.AUTO_DOWNLOAD_LOG) {
                setTimeout(() => this.downloadLogs(), 500);
            }
        }
    }
}

// Initialize logger
const logger = new ConsoleLogger();

// Expose to window for manual control
window.logger = logger;

// Auto-save feature (disabled by default - trigger manually after Dijkstra)
window.AUTO_DOWNLOAD_LOG = false; // Set to true to auto-download logs after Dijkstra

console.log('📝 Console logger initialized');
console.log('💡 Commands:');
console.log('   - logger.saveNow() : Save to server');
console.log('   - logger.downloadLogs() : Download as file');
console.log('   - window.AUTO_DOWNLOAD_LOG = true : Enable auto-download');
