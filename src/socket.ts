

import { io } from "socket.io-client";
import { Alert } from "react-native";



const socket = io("https://1fa4634fb106.ngrok-free.app", { // Android emulator
 transports: ["polling", "websocket"], 
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
  timeout: 10000,
});

// Add more detailed error handling
socket.on("connect", () => {
  console.log("🟢 Driver socket connected:", socket.id);
});

socket.on("connect_error", (err) => {
  console.log("🔴 Driver socket error:", err.message);
  // Only show alert for critical connection errors
  if (err.message === "Network Error" || err.message.includes("ECONNREFUSED")) {
    Alert.alert("Network Error", "Connection to server failed. Check your internet.");
  }
});

socket.on("disconnect", (reason) => {
  console.log("🔴 Driver socket disconnected:", reason);
  if (reason === "io server disconnect") {
    // Server disconnected, try to reconnect manually
    setTimeout(() => socket.connect(), 2000);
  }
});

socket.on("reconnect_failed", () => {
  console.log("🔴 Driver socket reconnection failed");
  Alert.alert("Network Error", "Unable to reconnect to the server. Restart the app.");
});

export default socket;