const express = require("express");
const { WebcastPushConnection } = require("tiktok-live-connector");
const http = require("http");
const socketIo = require("socket.io");
const axios = require("axios");

const config = {
    port: process.env.PORT || 4000,
    apiBaseUrl: process.env.API_BASE_URL || "https://camgm.com/api",
    dataUpdateInterval: 15000,
    roomInfoUpdateInterval: 15000,
};

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

class RoomState {
    constructor() {
        this.reset();
    }

    reset() {
        this.roomInfo = {};
        this.hlsInfo = {};
        this.members = [];
        this.users = {};
        this.gifts = [];
        this.followCount = 0;
        this.shareCount = 0;
    }

    update(newData) {
        Object.assign(this, newData);
    }

    toJSON() {
        return {
            room_info: this.roomInfo,
            hls_info: this.hlsInfo,
            members: this.members,
            users: this.users,
            gifts: this.gifts,
            follow_count: this.followCount,
            share_count: this.shareCount,
        };
    }
}

class ConnectionManager {
    constructor() {
        this.connections = new Map();
        this.intervals = new Map();
    }

    addConnection(jadwalId, handler) {
        this.connections.set(jadwalId, handler);
    }

    getConnection(jadwalId) {
        return this.connections.get(jadwalId);
    }

    removeConnection(jadwalId) {
        const handler = this.connections.get(jadwalId);
        if (handler) {
            handler.disconnect();
            this.clearIntervals(jadwalId);
        }
        this.connections.delete(jadwalId);
    }

    setInterval(jadwalId, interval) {
        this.intervals.set(jadwalId, interval);
    }

    clearIntervals(jadwalId) {
        const interval = this.intervals.get(jadwalId);
        if (interval) {
            clearInterval(interval);
            this.intervals.delete(jadwalId);
        }
    }

    disconnectAll() {
        for (const [jadwalId, handler] of this.connections) {
            handler.disconnect();
            this.clearIntervals(jadwalId);
        }
        this.connections.clear();
    }
}

const roomState = new RoomState();
const connectionManager = new ConnectionManager();

class ApiService {
    static usernameCache = new Map();

    static async fetchUsername(jadwalId) {
        if (this.usernameCache.has(jadwalId)) {
            return this.usernameCache.get(jadwalId);
        }

        try {
            const response = await axios.get(`${config.apiBaseUrl}/rekap/${jadwalId}/jadwal`);
            const username = response.data.data.program.room_tiktok;
            if (!username) throw new Error("Username not found");

            this.usernameCache.set(jadwalId, username);
            return username;
        } catch (error) {
            throw new Error(`Failed to fetch username: ${error.message}`);
        }
    }

    static clearCache(jadwalId) {
        this.usernameCache.delete(jadwalId);
    }

    static async saveData(jadwalId, data) {
        try {
            await axios.post(`${config.apiBaseUrl}/rekap/${jadwalId}`, data);
            console.log(`Data for jadwalId ${jadwalId} saved successfully`);
        } catch (error) {
            console.error(`Failed to save data: ${error.message}`);
        }
    }
}

class TikTokLiveHandler {
    constructor(username, jadwalId) {
        this.username = username;
        this.jadwalId = jadwalId;
        this.connection = new WebcastPushConnection(username);
    }

    async connect() {
        try {
            const state = await this.connection.connect();
            console.info(`Connected to roomId ${state.roomId} for jadwalId ${this.jadwalId}`);
            roomState.roomInfo.roomId = state.roomId;
            io.emit("roomConnected", { roomId: state.roomId, jadwalId: this.jadwalId });

            this.setupEventListeners();
            this.setupIntervals();

            return state;
        } catch (error) {
            console.error(`Connection failed for jadwalId ${this.jadwalId}: ${error.message}`);
        }
    }

    setupEventListeners() {
        this.connection.on("member", (data) => {
            roomState.members = data;
            io.emit("memberUpdate", { data, jadwalId: this.jadwalId });
        });

        this.connection.on("gift", (data) => {
            roomState.gifts = data;
            io.emit("giftUpdate", { data, jadwalId: this.jadwalId });
        });

        this.connection.on("roomUser", (data) => {
            roomState.users = data.topViewers;
            io.emit("userUpdate", { data, jadwalId: this.jadwalId });
        });

        this.connection.on("like", (data) => {
            roomState.roomInfo.totalLikeCount = (roomState.roomInfo.totalLikeCount || 0) + data.likeCount;
            io.emit("likeUpdate", { data, jadwalId: this.jadwalId });
        });

        this.connection.on("follow", () => {
            roomState.followCount++;
            io.emit("followUpdate", { count: roomState.followCount, jadwalId: this.jadwalId });
        });

        this.connection.on("share", () => {
            roomState.shareCount++;
            io.emit("shareUpdate", { count: roomState.shareCount, jadwalId: this.jadwalId });
        });

        this.connection.on("error", (error) => {
            console.error(`TikTok connection error for jadwalId ${this.jadwalId}: ${error.message}`);
            io.emit("error", { message: "Connection error occurred", jadwalId: this.jadwalId });
        });
    }

    setupIntervals() {
        const roomInfoInterval = setInterval(async () => {
            try {
                const roomInfo = await this.connection.getRoomInfo();
                roomState.update({
                    roomInfo: {
                        streamDuration: Math.floor(Date.now() / 1000 - roomInfo.create_time),
                        viewerCount: roomInfo.user_count,
                        totalLikeCount: roomInfo.like_count,
                    },
                    hlsInfo: roomInfo.hlsInfo,
                });
                io.emit("roomInfoUpdate", { roomInfo: roomState.roomInfo, jadwalId: this.jadwalId });
            } catch (error) {
                console.error(`Error updating room info for jadwalId ${this.jadwalId}: ${error.message}`);
            }
        }, config.roomInfoUpdateInterval);

        const dataSaveInterval = setInterval(async () => {
            try {
                await ApiService.saveData(this.jadwalId, roomState.toJSON());
            } catch (error) {
                console.error(`Error saving data for jadwalId ${this.jadwalId}: ${error.message}`);
            }
        }, config.dataUpdateInterval);

        connectionManager.setInterval(this.jadwalId, roomInfoInterval);
        connectionManager.setInterval(this.jadwalId, dataSaveInterval);
    }

    disconnect() {
        this.connection.disconnect();
        console.log(`Disconnected TikTok connection for jadwalId ${this.jadwalId}`);
    }
}

app.get("api/start/:jadwalId", async (req, res) => {
    const { jadwalId } = req.params;
    if (connectionManager.getConnection(jadwalId)) {
        return res.json({
            success: false,
            message: `Connection already exists for jadwalId ${jadwalId}`,
        });
    }
    try {
        const username = await ApiService.fetchUsername(jadwalId);
        const handler = new TikTokLiveHandler(username, jadwalId);
        await handler.connect();

        connectionManager.addConnection(jadwalId, handler);

        res.json({
            success: true,
            message: `Started TikTok live connection for jadwalId ${jadwalId}`,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

app.get("api/end/:jadwalId", async (req, res) => {
    const { jadwalId } = req.params;
    try {
        const handler = connectionManager.getConnection(jadwalId);
        if (!handler) throw new Error(`No active connection found for jadwalId ${jadwalId}`);

        handler.disconnect();
        connectionManager.removeConnection(jadwalId);
        ApiService.clearCache(jadwalId);
        roomState.reset();

        res.json({
            success: true,
            message: `Ended TikTok live connection for jadwalId ${jadwalId}`,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

server.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
});
