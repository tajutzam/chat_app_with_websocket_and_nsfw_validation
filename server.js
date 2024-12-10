const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { db, admin } = require("./firebase");

const multer = require("multer");
const sharp = require("sharp");

const tf = require("@tensorflow/tfjs-node");
const nsfw = require("nsfwjs");

const upload = multer();

let _model;

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

const convert = async (imgBuffer) => {
  try {
    const resizedBuffer = await sharp(imgBuffer)
      .resize(224, 224, { fit: "contain" }) // Resize to 224x224
      .removeAlpha() // Ensure no alpha channel
      .raw()
      .toBuffer(); // Get buffer output

    // Ensure buffer has the correct length for 224x224x3
    if (resizedBuffer.length !== 224 * 224 * 3) {
      throw new Error(
        `Incorrect buffer size: expected ${224 * 224 * 3}, got ${
          resizedBuffer.length
        }`
      );
    }
    return tf.tensor3d(new Uint8Array(resizedBuffer), [224, 224, 3], "int32");
  } catch (error) {
    console.error("Error in image conversion:", error.message);
    throw error;
  }
};

app.post("/create-room", async (req, res) => {
  const { roomId } = req.body;

  if (!roomId) {
    return res.status(400).json({
      errors: {
        message: "Missing roomId",
      },
    });
  }

  try {
    const existingRoom = await db
      .collection("messages")
      .where("roomId", "==", roomId)
      .get();

    if (!existingRoom.empty) {
      return res.status(400).json({
        errors: {
          message: "Room already exists!",
        },
      });
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("messages").add({
      roomId,
      message: "Chat Is Started",
      timestamp,
    });

    res.status(201).json({
      message: "Room created successfully!",
      room: {
        roomId,
        timestamp,
      },
    });
  } catch (error) {
    console.error("Error creating room:", error.message);
    res.status(500).json({
      errors: {
        message: "Failed to create room: " + error.message,
      },
    });
  }
});

const axios = require("axios");

app.post("/nsfw", async (req, res) => {
  const { imageUrl, roomId, sender } = req.body;

  if (!imageUrl) {
    return res.status(400).send("Missing image URL in request body");
  }

  if (!roomId || !sender) {
    return res.status(400).send("Missing roomId or sender");
  }

  try {
    // Fetch image from the provided URL
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(response.data);

    const image = await convert(imageBuffer);
    const predictions = await _model.classify(image);
    image.dispose();

    const bucket = admin.storage().bucket();
    const filename = `images/${Date.now()}_${imageUrl.split("/").pop()}`;
    const file = bucket.file(filename);

    const existRooms = await db
      .collection("messages")
      .where("roomId", "==", roomId)
      .get();

    if (existRooms.empty) {
      return res.status(400).json({
        errors: {
          message:
            "Room not found, please create a room before starting the chat!",
        },
      });
    }

    await file.save(imageBuffer, {
      metadata: {
        contentType: response.headers["content-type"],
      },
    });

    const [url] = await file.getSignedUrl({
      action: "read",
      expires: "03-01-2030",
    });

    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("messages").add({
      sender,
      message: "Image uploaded",
      imageLink: url,
      timestamp,
      roomId,
      imagePredictions: predictions[0],
    });

    res.json({
      roomId,
      predictions,
      file: {
        sender,
        imageLink: url,
      },
    });
  } catch (error) {
    console.error("Error processing image:", error.message);
    res.status(500).send("Failed to process the image: " + error.message);
  }
});

const load_model = async () => {
  _model = await nsfw.load();
};

io.on("connection", (socket) => {
  console.log("A user connected");

  socket.on("join_room", (roomId) => {
    socket.join(roomId);
    console.log(`User joined room: ${roomId}`);

    db.collection("messages")
      .where("roomId", "==", roomId)
      .orderBy("timestamp") // Ensure that the messages are ordered by timestamp
      .get()
      .then((snapshot) => {
        const messages = snapshot.docs.map((doc) => doc.data());
        socket.emit("load_previous_messages", messages); // Emit the messages to the client
      })
      .catch((err) => {
        console.error("Error getting messages:", err);
        socket.emit("load_previous_messages", []); // If there's an error, send an empty array
      });
  });

  socket.on("send_message", (data) => {
    const { roomId, message, sender } = data;
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    console.log(`Message from ${sender} to room ${roomId}: ${message}`);

    db.collection("messages")
      .add({
        roomId,
        sender,
        message,
        timestamp,
      })
      .then(() => {
        io.to(roomId).emit("receive_message", { sender, message, timestamp });
      })
      .catch((err) => console.error("Error saving message:", err));
  });

  socket.on("disconnect", () => {
    console.log("A user disconnected");
  });
});

const PORT = process.env.PORT || 3000;

load_model().then(() =>
  server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  })
);
