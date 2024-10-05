"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const client_1 = require("@prisma/client");
const dotenv_1 = __importDefault(require("dotenv"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const cloudinary_1 = __importDefault(require("cloudinary"));
const cors_1 = __importDefault(require("cors"));
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const prisma = new client_1.PrismaClient();
// Define ConversationType enum to match your Prisma schema
var ConversationType;
(function (ConversationType) {
    ConversationType["PRIVATE"] = "PRIVATE";
    ConversationType["COMMUNITY"] = "COMMUNITY";
})(ConversationType || (ConversationType = {}));
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
}));
const io = new socket_io_1.Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
    },
});
app.use(express_1.default.json());
// Configure Cloudinary
cloudinary_1.default.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});
// Create uploads directory if it doesn't exist
const uploadDir = path_1.default.join(__dirname, 'uploads');
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir);
}
// Configure Multer for disk storage
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path_1.default.extname(file.originalname));
    },
});
const upload = (0, multer_1.default)({
    storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|pdf/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path_1.default.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        else {
            cb(new Error('Error: File upload only supports the following filetypes - ' + filetypes));
        }
    },
});
// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }
    try {
        const result = yield cloudinary_1.default.v2.uploader.upload(req.file.path, {
            folder: 'uploads',
        });
        fs_1.default.unlinkSync(req.file.path);
        res.json({ filePath: result.secure_url });
    }
    catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({ error: 'File upload failed' });
    }
}));
// Socket.io connection
io.on('connection', (socket) => {
    console.log('A user connected: ' + socket.id);
    socket.on("getsetId", (_a) => __awaiter(void 0, [_a], void 0, function* ({ userId }) {
        try {
            // Find the user by userId
            const user = yield prisma.user.findFirst({
                where: {
                    id: userId,
                },
            });
            console.log("user" + user);
            if (user) {
                // Update the user's socket_id
                const updatedUser = yield prisma.user.update({
                    where: {
                        id: user.id,
                    },
                    data: {
                        socket_id: socket.id
                    },
                });
                console.log("User updated with socket_id:", updatedUser);
            }
            else {
                console.log("User not found");
                socket.emit("error", { message: "User not found" });
            }
        }
        catch (error) {
            console.error("Error fetching or updating user:", error);
            socket.emit("error", { message: "Internal server error" });
        }
    }));
    socket.on('getSocketIds', (userIds) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const users = yield prisma.user.findMany({
                where: {
                    id: {
                        in: userIds
                    }
                },
                select: {
                    id: true,
                    socket_id: true
                }
            });
            const socketIds = users.reduce((acc, user) => {
                if (user.socket_id) {
                    acc[user.id] = user.socket_id;
                }
                return acc;
            }, {});
            socket.emit('socketIds', socketIds);
        }
        catch (error) {
            console.error('Error fetching socket IDs:', error);
            socket.emit('error', { message: 'Error fetching socket IDs, please try again later.' });
        }
    }));
    socket.on('joinRoom', (_a) => __awaiter(void 0, [_a], void 0, function* ({ doctorId, clientId }) {
        if (!doctorId || !clientId) {
            socket.emit('error', { message: 'Invalid room ID format' });
            return;
        }
        const roomId = `room_${doctorId}_${clientId}`;
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
        try {
            let conversation = yield prisma.conversation.findFirst({
                where: {
                    participants: {
                        every: {
                            userId: {
                                in: [doctorId, clientId],
                            },
                        },
                    },
                },
                include: {
                    messages: {
                        include: {
                            sender: true, // Include sender information
                            seenBy: true, // Include seenBy information
                        },
                        orderBy: {
                            createdAt: 'asc',
                        },
                    },
                    participants: true,
                },
            });
            if (conversation) {
                // Transform messages to include sender name and seenBy information
                const transformedMessages = conversation.messages.map(message => (Object.assign(Object.assign({}, message), { senderName: message.sender.name, seenBy: message.seenBy.map(seen => ({
                        userId: seen.userId,
                        seenAt: seen.seenAt.toISOString(),
                    })) })));
                const participant = conversation.participants.find(p => p.userId === socket.id);
                const unreadCount = participant ? participant.unreadCount : 0;
                socket.emit('conversationId', conversation.id);
                console.log('conversationId', conversation.id);
                socket.emit('previousMessages', { message: transformedMessages, unreadCount });
            }
            else {
                console.log("new");
                // Create a new conversation if none exists
                let newConversation = yield prisma.conversation.create({
                    data: {
                        participants: {
                            create: [
                                { userId: doctorId },
                                { userId: clientId },
                            ],
                        },
                    },
                    include: {
                        messages: {
                            include: {
                                seenBy: true, // Include seenBy information
                            },
                        },
                        participants: true,
                    },
                });
                socket.emit('conversationId', newConversation.id);
                socket.emit('previousMessages', []);
            }
        }
        catch (error) {
            console.error('Error fetching previous messages:', error);
            socket.emit('error', { message: 'Error fetching messages, please try again later.' });
        }
    }));
    // Sending a message
    socket.on('sendMessage', (data) => __awaiter(void 0, void 0, void 0, function* () {
        console.log("Received data: ", data);
        try {
            let conversation;
            if (data.conversationType === "PRIVATE") {
                // Handle PRIVATE conversations between two participants
                conversation = yield prisma.conversation.findUnique({
                    where: { id: data.conversationId },
                    include: { participants: true },
                });
                // If no conversation exists, create one between doctor and client
                if (!conversation) {
                    const [doctorId, clientId] = data.roomId.split('_');
                    // console.log(doctorId,clientId)
                    conversation = yield prisma.conversation.create({
                        data: {
                            type: "PRIVATE",
                            participants: {
                                create: [
                                    { userId: doctorId },
                                    { userId: clientId },
                                ],
                            },
                        },
                        include: { participants: true },
                    });
                }
            }
            else if (data.conversationType === "COMMUNITY") {
                // Handle COMMUNITY messages based on the conversationId
                conversation = yield prisma.conversation.findUnique({
                    where: { id: data.conversationId },
                    include: { participants: true },
                });
                if (!conversation) {
                    throw new Error("Community conversation not found");
                }
                // Check if the sender is a participant in the community
                const isMember = conversation.participants.some(p => p.userId === data.senderId);
                if (!isMember) {
                    socket.emit('error', { message: 'You are not a member of this community.' });
                    return;
                }
                // Check if the sender is a doctor (if that's still a requirement)
                const sender = yield prisma.user.findUnique({ where: { id: data.senderId } });
                if ((sender === null || sender === void 0 ? void 0 : sender.role) !== 'DOCTOR') {
                    socket.emit('error', { message: 'Only doctors can send messages in this community.' });
                    return;
                }
            }
            // Create the new message
            const newMessage = yield prisma.message.create({
                data: {
                    content: data.message,
                    senderId: data.senderId,
                    conversationId: data.conversationId,
                    fileName: data.fileName,
                    filePath: data.filePath,
                    fileType: data.fileType,
                },
                include: {
                    seenBy: true
                }
            });
            const senderDetails = yield prisma.user.findUnique({
                where: { id: data.senderId },
                select: { id: true, name: true }, // You can add more fields if needed
            });
            yield prisma.conversationParticipant.updateMany({
                where: {
                    conversationId: data.conversationId,
                    userId: {
                        not: data.senderId
                    }
                },
                data: {
                    unreadCount: {
                        increment: 1
                    }
                }
            });
            // Construct the message object to emit
            const messageToSend = Object.assign(Object.assign({}, newMessage), { senderName: (senderDetails === null || senderDetails === void 0 ? void 0 : senderDetails.name) || 'Unknown' });
            // Determine the room to emit the message to
            const roomId = data.conversationType === "COMMUNITY"
                ? `community_${data.conversationId}`
                : data.roomId;
            // Broadcast the new message to the appropriate room
            io.to(roomId).emit('receivedMessage', messageToSend);
            console.log('Message sent:', messageToSend);
        }
        catch (error) {
            console.error("Error sending message:", error);
            socket.emit('error', { message: 'Error sending message, please try again later.' });
        }
    }));
    // Add this event handler for joining community rooms
    socket.on('joinCommunity', (data) => __awaiter(void 0, void 0, void 0, function* () {
        const { conversationId, userId } = data;
        try {
            const conversation = yield prisma.conversation.findUnique({
                where: { id: conversationId },
                include: {
                    participants: true,
                    messages: {
                        include: {
                            sender: {
                                select: {
                                    id: true, // Include sender's ID if needed
                                    name: true // Include sender's name
                                }
                            }
                        }
                    }
                }
            });
            console.log("Conversations = ", conversation);
            const participant = conversation === null || conversation === void 0 ? void 0 : conversation.participants.find(p => p.userId === userId);
            if (!conversation) {
                throw new Error("Community not found");
            }
            const isMember = conversation.participants.some(p => p.userId === userId);
            if (!isMember) {
                throw new Error("User is not a member of this community");
            }
            const communityRoomId = `community_${conversationId}`;
            socket.join(communityRoomId);
            socket.emit('previousMessages', { message: conversation.messages, unreadCount: participant === null || participant === void 0 ? void 0 : participant.unreadCount });
            console.log(`User ${userId} joined community room ${communityRoomId}`);
        }
        catch (error) {
            console.error("Error joining community:", error);
            socket.emit('error', { message: 'Error joining community, please try again later.' });
        }
    }));
    socket.on('resetUnreadCount', (_a) => __awaiter(void 0, [_a], void 0, function* ({ userId, conversationId }) {
        try {
            yield prisma.conversationParticipant.updateMany({
                where: {
                    conversationId: conversationId,
                    userId: userId
                },
                data: {
                    unreadCount: 0
                }
            });
            socket.emit('unreadCountReset', { conversationId });
        }
        catch (error) {
            console.error("Error resetting unread count:", error);
            socket.emit('error', { message: 'Error resetting unread count, please try again later.' });
        }
    }));
    socket.on('fileUpload', (data) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const conversation = yield prisma.conversation.findUnique({
                where: { id: data.conversationId },
                include: { participants: true },
            });
            if (!conversation) {
                socket.emit('error', { message: 'Conversation not found.' });
                return;
            }
            if (conversation.type === ConversationType.COMMUNITY) {
                const isDoctor = conversation.participants.some((p) => p.userId === data.senderId);
                if (!isDoctor) {
                    socket.emit('error', { message: 'You are not allowed to upload files in this community.' });
                    return;
                }
            }
            const newMessage = yield prisma.message.create({
                data: {
                    content: 'File uploaded',
                    senderId: data.senderId,
                    conversationId: data.conversationId,
                    filePath: data.filePath,
                    fileName: data.fileName,
                    fileType: data.fileType,
                },
            });
            const roomId = conversation.type === "COMMUNITY"
                ? `community_${data.conversationId}`
                : data.roomId;
            io.to(roomId).emit('receivedMessage', newMessage);
        }
        catch (error) {
            console.error('Error handling file upload:', error);
            socket.emit('error', { message: 'Error uploading file, please try again later.' });
        }
    }));
    socket.on('createCommunity', (_a) => __awaiter(void 0, [_a], void 0, function* ({ communityMembers, newCommunityName }) {
        try {
            const community = yield prisma.conversation.create({
                data: {
                    type: "COMMUNITY",
                    communityName: newCommunityName,
                },
            });
            const formattedCommunityMembers = communityMembers.map((userId) => ({
                userId: userId, // User ID for each participant
                conversationId: community.id, // Use the community ID here
                // joinedAt: new Date() // Optional: This will default to now() if omitted
            }));
            // Step 3: Add participants to the community
            yield prisma.conversationParticipant.createMany({
                data: formattedCommunityMembers,
            });
            // Emit success message
            socket.emit('communityCreated', community);
        }
        catch (error) {
            console.error('Error creating community:', error);
            socket.emit('error', { message: 'Error creating community, please try again later.' });
        }
    }));
    socket.on('markAsSeen', (_a) => __awaiter(void 0, [_a], void 0, function* ({ userId, conversationId, lastSeenMessageId }) {
        try {
            const unseenMessages = yield prisma.message.findMany({
                where: {
                    conversationId: conversationId,
                    id: { lte: lastSeenMessageId },
                    NOT: {
                        seenBy: {
                            some: { userId: userId }
                        }
                    }
                },
            });
            for (const message of unseenMessages) {
                yield prisma.seenMessage.create({
                    data: {
                        messageId: message.id,
                        userId: userId,
                    }
                });
            }
            const updatedMessages = yield prisma.message.findMany({
                where: {
                    conversationId: conversationId,
                    id: { lte: lastSeenMessageId }
                },
                include: {
                    seenBy: true
                }
            });
            io.to(`room_${conversationId}`).emit('messagesSeen', { userId, lastSeenMessageId, updatedMessages });
        }
        catch (error) {
            console.error('Error marking messages as seen:', error);
            socket.emit('error', { message: 'Error updating seen status, please try again later.' });
        }
    }));
    //connecting to call
    console.log('A user connected');
    socket.emit('me', socket.id);
    socket.on('declineCall', (data) => {
        io.to(data.to).emit('callDeclined');
    });
    socket.on('endCall', (data) => {
        io.to(data.to).emit('callEnded');
    });
    //call user
    socket.on("callUser", (data) => {
        io.to(data.userToCall).emit("callUser", { signal: data.signalData, from: data.from, name: data.name });
        console.log("call user backend", data);
    });
    //Answer call
    socket.on("answerCall", (data) => {
        console.log("answeing call");
        io.to(data.to).emit("callAccepted", data.signal);
    });
    // Disconnect event
    socket.on('disconnect', () => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const updatedUser = yield prisma.user.updateMany({
                where: {
                    socket_id: socket.id,
                },
                data: {
                    socket_id: null,
                },
            });
            if (updatedUser.count > 0) {
                console.log(`Socket ID ${socket.id} set to null for ${updatedUser.count} user(s).`);
            }
            else {
                console.log(`No user found with socket ID ${socket.id}`);
            }
        }
        catch (error) {
            console.error(`Error setting socket ID to null in the database:`, error);
        }
        console.log('User disconnected: ' + socket.id);
    }));
});
// Start the server
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
