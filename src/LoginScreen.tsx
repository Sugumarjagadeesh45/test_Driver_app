// src/LoginScreen.tsx
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  Linking,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Geolocation from "@react-native-community/geolocation";
import api from "../utils/api"; // Axios instance pointing to your backend

interface LoginScreenProps {
  navigation: any;
}

// ---------------- Type for coordinates ----------------
interface Coordinates {
  latitude: number;
  longitude: number;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ navigation }) => {
  const [driverId, setDriverId] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  
  // Console log for component initialization
  console.log("🔑 LoginScreen component initialized");

  // ---------------- Request location permission ----------------
  const requestLocationPermission = async (): Promise<boolean> => {
    console.log("🔐 Requesting location permission...");
    
    if (Platform.OS === "android") {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: "Location Permission",
          message: "We need your location to login",
          buttonNeutral: "Ask Me Later",
          buttonNegative: "Cancel",
          buttonPositive: "OK",
        }
      );
      
      console.log("📱 Android permission result:", granted);
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    
    console.log("📱 iOS - permission assumed granted");
    return true;
  };

  // ---------------- Prompt user to enable High Accuracy ----------------
  const promptEnableHighAccuracy = () => {
    console.log("⚠️ Prompting user to enable high accuracy GPS");
    Alert.alert(
      "⚠️ Enable High Accuracy",
      "Your GPS is not in High Accuracy mode. Please enable it for proper login.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Open Settings",
          onPress: () => {
            console.log("📱 Opening device settings");
            Linking.openSettings();
          },
        },
      ]
    );
  };

  // ---------------- Get current location with retry ----------------
  const getLocation = async (retries = 2): Promise<Coordinates> => {
    console.log(`📍 Getting location (attempt ${retries + 1})...`);
    
    for (let i = 0; i <= retries; i++) {
      try {
        console.log(`🔄 Location attempt ${i + 1}...`);
        const coords = await new Promise<Coordinates>((resolve, reject) => {
          Geolocation.getCurrentPosition(
            (pos) => {
              console.log("✅ Position obtained:", {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy
              });
              resolve(pos.coords);
            },
            (err) => {
              console.error("❌ Geolocation error:", {
                code: err.code,
                message: err.message
              });
              
              if (err.code === 2) promptEnableHighAccuracy();
              reject(err);
            },
            { enableHighAccuracy: true, timeout: 60000, maximumAge: 0 }
          );
        });
        return coords; // success
      } catch (err) {
        console.error(`❌ Location attempt ${i + 1} failed:`, err.message);
        if (i === retries) throw err; // last attempt, throw error
      }
    }
    throw new Error("Unable to get location");
  };

  // ---------------- Handle Login ----------------
  const handleLogin = async () => {
    console.log("🚀 Login process started");
    
    if (!driverId || !password) {
      console.log("⚠️ Missing credentials:", {
        hasDriverId: !!driverId,
        hasPassword: !!password
      });
      Alert.alert("⚠️ Input Error", "Please enter driver ID and password");
      return;
    }
    
    setLoading(true);
    
    // Console log for driver ID input
    console.log("📝 Driver ID Input:", driverId);
    
    const hasPermission = await requestLocationPermission();
    if (!hasPermission) {
      setLoading(false);
      console.log("❌ Location permission denied");
      Alert.alert("⚠️ Permission Denied", "Location is required to login.");
      return;
    }
    
    try {
      console.log("📍 Getting current location...");
      const { latitude, longitude } = await getLocation();
      console.log("✅ Location obtained:", { latitude, longitude });
      
      console.log("🌐 Sending login request to server...");
      console.log("Login with driver ID:", driverId);
      
      const res = await api.post("/drivers/login", {
        driverId,
        password,
        latitude,
        longitude,
      });
      
      console.log("📡 Login response received:", {
        status: res.status,
        data: res.data
      });
      
      if (res.status === 200) {
        const driver = res.data.driver;
        console.log("✅ Login successful, driver data:", driver);
        
        // Store auth info
        console.log("💾 Storing authentication data...");
        await AsyncStorage.multiSet([
          ["isRegistered", "true"],
          ["driverId", driver.driverId],
          ["driverName", driver.name],
          ["authToken", res.data.token],
        ]);
        
        console.log("✅ Authentication data stored in AsyncStorage");
        
        // Navigate to Screen1 with driver information
        console.log("🧭 Navigating to Screen1...");
        navigation.replace("Screen1", {
          driverId: driver.driverId,
          driverName: driver.name,
          latitude,
          longitude,
        });
        
        console.log("✅ Login process completed successfully");
      } else {
        console.error("❌ Login failed with status:", res.status);
        Alert.alert("❌ Login Failed", res.data.msg || "Invalid credentials");
      }
    } catch (err: any) {
      console.error("❌ Location/Login Error:", err);
      
      if (err.code === 1) {
        // PERMISSION_DENIED
        console.error("❌ Location permission denied");
        Alert.alert("❌ Permission Denied", "Location permission is required.");
      } else if (err.code === 2) {
        // POSITION_UNAVAILABLE
        console.error("❌ GPS position unavailable");
        promptEnableHighAccuracy();
      } else if (err.code === 3) {
        // TIMEOUT
        console.error("❌ GPS timeout");
        Alert.alert(
          "❌ GPS Timeout",
          "Could not get location. Make sure GPS is enabled and try again."
        );
      } else if (err.response) {
        // API error
        console.error("❌ API error response:", err.response.data);
        Alert.alert("❌ Login Failed", err.response.data.msg || "Invalid credentials");
      } else {
        console.error("❌ Unknown error:", err.message);
        Alert.alert(
          "❌ GPS/Login Error",
          "Cannot get location. Please enable GPS High Accuracy and try again."
        );
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Driver Login</Text>
      <TextInput
        style={styles.input}
        placeholder="Driver ID"
        value={driverId}
        onChangeText={(text) => {
          console.log("📝 Driver ID input changed:", text);
          setDriverId(text);
        }}
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={(text) => {
          console.log("🔑 Password input changed");
          setPassword(text);
        }}
        secureTextEntry
      />
      <TouchableOpacity
        style={styles.button}
        onPress={handleLogin}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Login</Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

export default LoginScreen;

// ---------------- Styles ----------------
const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    justifyContent: "center", 
    alignItems: "center", 
    padding: 20, 
    backgroundColor: "#f5f5f5" 
  },
  title: { 
    fontSize: 28, 
    fontWeight: "bold", 
    marginBottom: 30 
  },
  input: { 
    width: "100%", 
    padding: 12, 
    marginBottom: 15, 
    borderWidth: 1, 
    borderColor: "#ccc", 
    borderRadius: 8, 
    backgroundColor: "#fff" 
  },
  button: { 
    width: "100%", 
    padding: 15, 
    backgroundColor: "#28a745", 
    borderRadius: 8, 
    alignItems: "center" 
  },
  buttonText: { 
    color: "#fff", 
    fontWeight: "bold", 
    fontSize: 16 
  },
});