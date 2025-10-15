// D:\newapp\driverapp-main\driverapp-main\src\apiConfig.ts
import { Platform } from 'react-native';

// Toggle this flag to switch between environments
const useLocalhost = false; // 👈 Set to true for local, false for production

// For local testing, use appropriate IP for emulators/devices
const LOCAL_API_URL = Platform.select({
  ios: "http://localhost:5001/api",      // iOS simulator
  android: "http://10.0.2.2:5001/api",   // Android emulator
  default: "http://192.168.1.107:5001/api", // Local network IP (adjust as needed)
});

const LOCAL_SOCKET_URL = Platform.select({
  ios: "http://localhost:5001",
  android: "http://10.0.2.2:5001",
  default: "http://192.168.1.107:5001",
});

// Live server URLs
const LIVE_API_URL = "https://new-fullbackend.onrender.com/api";
const LIVE_SOCKET_URL = "https://new-fullbackend.onrender.com";

export const API_BASE = useLocalhost
  ? LOCAL_API_URL
  : LIVE_API_URL;

export const SOCKET_URL = useLocalhost
  ? LOCAL_SOCKET_URL
  : LIVE_SOCKET_URL;
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
//   // Toggle this flag to switch between environments
// const useLocalhost = true; // development


// // For local testing, use appropriate IP for emulators/devices
// const LOCAL_API_URL = Platform.select({
//   ios: "http://localhost:5001/api",      // iOS simulator
//   android: "http://10.0.2.2:5001/api",   // Android emulator
//   default: "http://192.168.1.107:5001/api", // Local network IP (adjust as needed)
// });

// const LOCAL_SOCKET_URL = Platform.select({
//   ios: "http://localhost:5001",
//   android: "http://10.0.2.2:5001",
//   default: "http://192.168.1.107:5001",
// });

// export const API_BASE = useLocalhost
//   ? LOCAL_API_URL
//   : "https://95e02d1f7b03.ngrok-free.app/api";

// const SOCKET_URL = useLocalhost 
//     ? LOCAL_SOCKET_URL
//     : "https://95e02d1f7b03.ngrok-free.app";
