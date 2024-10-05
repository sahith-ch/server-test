import express, { Request, Response } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { PrismaClient, Conversation, Message,Prisma, ConversationParticipant } from '@prisma/client';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cloudinary from 'cloudinary';
import cors from 'cors';

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// Define ConversationType enum to match your Prisma schema
enum ConversationType {
    PRIVATE = 'PRIVATE',
    COMMUNITY = 'COMMUNITY',
}

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
}));

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
    },
});

app.use(express.json());

// Configure Cloudinary
cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configure Multer for disk storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|pdf/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Error: File upload only supports the following filetypes - ' + filetypes));
        }
    },
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }

    try {
        const result = await cloudinary.v2.uploader.upload(req.file.path, {
            folder: 'uploads',
        });

        fs.unlinkSync(req.file.path);

        res.json({ filePath: result.secure_url });
    } catch (error) {
        console.error('Error uploading file:', error);
        res.status(500).json({ error: 'File upload failed' });
    }
});

interface GetSetIdPayload {
    userId: string;
}

type MessageWithSeenBy = Prisma.MessageGetPayload<{
    include: { seenBy: true }
  }>;

// Socket.io connection
io.on('connection', (socket) => {
    console.log('A user connected: ' + socket.id);

    socket.on("getsetId", async ({ userId }: GetSetIdPayload) => {
        try {
            // Find the user by userId
            const user = await prisma.user.findFirst({
                where: {
                    id: userId,
                },
            });
            console.log("user"+user);
            if (user) {
                // Update the user's socket_id
                const updatedUser = await prisma.user.update({
                    where: {
                        id: user.id,
                    },
                    data: {
                        socket_id: socket.id
                    },
                });
    
                console.log("User updated with socket_id:", updatedUser);
            } else {
                console.log("User not found");
                socket.emit("error", { message: "User not found" });
            }
        } catch (error) {
            console.error("Error fetching or updating user:", error);
            socket.emit("error", { message: "Internal server error" });
        }
    });

    socket.on('getSocketIds', async (userIds: string[]) => {
        try {
            const users = await prisma.user.findMany({
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
            }, {} as Record<string, string>);

            socket.emit('socketIds', socketIds);
        } catch (error) {
            console.error('Error fetching socket IDs:', error);
            socket.emit('error', { message: 'Error fetching socket IDs, please try again later.' });
        }
    });

    
    socket.on('joinRoom', async ({ doctorId, clientId }: { doctorId: string; clientId: string }) => {
        if (!doctorId || !clientId) {
            socket.emit('error', { message: 'Invalid room ID format' });
            return;
        }
    
        const roomId = `room_${doctorId}_${clientId}`;
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
    
        try {
            let conversation = await prisma.conversation.findFirst({
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
                const transformedMessages = conversation.messages.map(message => ({
                    ...message,
                    senderName: message.sender.name, // Add sender's name
                    seenBy: message.seenBy.map(seen => ({
                        userId: seen.userId,
                        seenAt: seen.seenAt.toISOString(),
                    })),
                }));
    
                const participant = conversation.participants.find(p => p.userId === socket.id);
                const unreadCount = participant ? participant.unreadCount : 0;
    
                socket.emit('conversationId', conversation.id);
                console.log('conversationId', conversation.id);
                socket.emit('previousMessages', { message: transformedMessages, unreadCount });
            } else {
                console.log("new")
                // Create a new conversation if none exists
                let newConversation = await prisma.conversation.create({
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
        } catch (error) {
            console.error('Error fetching previous messages:', error);
            socket.emit('error', { message: 'Error fetching messages, please try again later.' });
        }
    });
    
    // Sending a message
    socket.on('sendMessage', async (data) => {
        console.log("Received data: ", data);
    
        try {
            let conversation;
    
            if (data.conversationType === "PRIVATE") {
                // Handle PRIVATE conversations between two participants
                conversation = await prisma.conversation.findUnique({
                    where: { id: data.conversationId },
                    include: { participants: true },
                });
    
                // If no conversation exists, create one between doctor and client
                if (!conversation) {
                    const [doctorId, clientId] = data.roomId.split('_');
                   // console.log(doctorId,clientId)
                    conversation = await prisma.conversation.create({
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
                conversation = await prisma.conversation.findUnique({
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
                const sender = await prisma.user.findUnique({ where: { id: data.senderId } });
                if (sender?.role !== 'DOCTOR') {
                    socket.emit('error', { message: 'Only doctors can send messages in this community.' });
                    return;
                }
            }
    
            // Create the new message
                
                const newMessage = await prisma.message.create({
                    data: {
                        content: data.message,
                        senderId: data.senderId,
                        conversationId: data.conversationId,
                        fileName: data.fileName,
                        filePath: data.filePath,
                        fileType: data.fileType,
                    },
                    include:{
                        seenBy:true
                    }
                });
        
                const senderDetails = await prisma.user.findUnique({
                    where: { id: data.senderId },
                    select: { id: true, name: true }, // You can add more fields if needed
                });
                await prisma.conversationParticipant.updateMany({
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
                const messageToSend = {
                    ...newMessage,
                    senderName: senderDetails?.name || 'Unknown', // Handle case where name is not found
                };
        
                // Determine the room to emit the message to
                const roomId = data.conversationType === "COMMUNITY" 
                    ? `community_${data.conversationId}`
                    : data.roomId;
                // Broadcast the new message to the appropriate room
                io.to(roomId).emit('receivedMessage', messageToSend);
        
                console.log('Message sent:', messageToSend);
    
        } catch (error) {
            console.error("Error sending message:", error);
            socket.emit('error', { message: 'Error sending message, please try again later.' });
        }
    });
    
    // Add this event handler for joining community rooms
    socket.on('joinCommunity', async (data) => {
        const { conversationId, userId } = data;
        try {
            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId },
                include: {
                    participants: true,
                    messages: {
                        include: {
                            sender: {
                                select: {
                                    id: true,  // Include sender's ID if needed
                                    name: true // Include sender's name
                                }
                            }
                        }
                    }
                }
            });
    
            console.log("Conversations = ",conversation)
            const participant = conversation?.participants.find(p => p.userId === userId);

            if (!conversation) {
                throw new Error("Community not found");
            }
            const isMember = conversation.participants.some(p => p.userId === userId);
            if (!isMember) {
                throw new Error("User is not a member of this community");
            }
    
            const communityRoomId = `community_${conversationId}`;
            socket.join(communityRoomId);
         socket.emit('previousMessages', {message:conversation.messages,unreadCount:participant?.unreadCount });

            console.log(`User ${userId} joined community room ${communityRoomId}`);
    
        } catch (error) {
            console.error("Error joining community:", error);
            socket.emit('error', { message: 'Error joining community, please try again later.' });
        }
    });
    socket.on('resetUnreadCount', async ({ userId, conversationId }) => {
        try {
            await prisma.conversationParticipant.updateMany({
                where: {
                    conversationId: conversationId,
                    userId: userId
                },
                data: {
                    unreadCount: 0
                }
            });
            socket.emit('unreadCountReset', { conversationId });
        } catch (error) {
            console.error("Error resetting unread count:", error);
            socket.emit('error', { message: 'Error resetting unread count, please try again later.' });
        }
    });
    socket.on('fileUpload', async (data: {conversationType:string, roomId:string,conversationId: string; senderId: string; filePath: string; fileName: string; fileType: string }) => {
        try {
            const conversation = await prisma.conversation.findUnique({
                where: { id: data.conversationId },
                include: { participants: true },
            });
            if (!conversation) {
                socket.emit('error', { message: 'Conversation not found.' });
                return;
            }

            if (conversation.type === ConversationType.COMMUNITY) {
                const isDoctor = conversation.participants.some((p: ConversationParticipant) => p.userId === data.senderId);
                if (!isDoctor) {
                    socket.emit('error', { message: 'You are not allowed to upload files in this community.' });
                    return;
                }
            }

            const newMessage = await prisma.message.create({
                data: {
                    content: 'File uploaded',
                    senderId: data.senderId,
                    conversationId: data.conversationId,
                    filePath: data.filePath,
                    fileName: data.fileName,
                    fileType: data.fileType,
                },
            });
const roomId =conversation.type === "COMMUNITY" 
? `community_${data.conversationId}`
: data.roomId;
            io.to(roomId).emit('receivedMessage', newMessage);
        } catch (error) {
            console.error('Error handling file upload:', error);
            socket.emit('error', { message: 'Error uploading file, please try again later.' });
        }
    });

    socket.on('createCommunity', async ({ communityMembers, newCommunityName }) => {
        try {
            const community = await prisma.conversation.create({
                data: {
                    type: "COMMUNITY",
                    communityName: newCommunityName,
                },
            });
    
          const formattedCommunityMembers = communityMembers.map((userId:string) => ({
                userId: userId, // User ID for each participant
                conversationId: community.id, // Use the community ID here
                // joinedAt: new Date() // Optional: This will default to now() if omitted
            }));
    
            // Step 3: Add participants to the community
            await prisma.conversationParticipant.createMany({
                data: formattedCommunityMembers,
            });
    
            // Emit success message
            socket.emit('communityCreated', community);
        } catch (error) {
            console.error('Error creating community:', error);
            socket.emit('error', { message: 'Error creating community, please try again later.' });
        }
    });


    socket.on('markAsSeen', async ({ userId, conversationId, lastSeenMessageId }) => {
        try {
            const unseenMessages = await prisma.message.findMany({
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
                await prisma.seenMessage.create({
                    data: {
                        messageId: message.id,
                        userId: userId,
                    }
                });
            }
    
            const updatedMessages = await prisma.message.findMany({
                where: {
                    conversationId: conversationId,
                    id: { lte: lastSeenMessageId }
                },
                include: {
                    seenBy: true
                }
            });
    
            io.to(`room_${conversationId}`).emit('messagesSeen', { userId, lastSeenMessageId, updatedMessages });
        } catch (error) {
            console.error('Error marking messages as seen:', error);
            socket.emit('error', { message: 'Error updating seen status, please try again later.' });
        }
    });
    


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
    socket.on("callUser",(data)=>{
         io.to(data.userToCall).emit("callUser",{signal: data.signalData , from:data.from , name:data.name});
         console.log("call user backend",data);
         
    })

    //Answer call
    socket.on("answerCall", (data) => {
        console.log("answeing call");
        
		io.to(data.to).emit("callAccepted", data.signal)
	})




    // Disconnect event
    socket.on('disconnect', async() => {
        try {
            const updatedUser = await prisma.user.updateMany({
                where: {
                  socket_id: socket.id, 
                },
                data: {
                  socket_id: null, 
          
                },
            });
            if (updatedUser.count > 0) {
                console.log(`Socket ID ${socket.id} set to null for ${updatedUser.count} user(s).`);
              } else {
                console.log(`No user found with socket ID ${socket.id}`);
              }
            
            
        } catch (error) {
            console.error(`Error setting socket ID to null in the database:`, error);
            
        }
        console.log('User disconnected: ' + socket.id);
        
    });
});

// Start the server
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
