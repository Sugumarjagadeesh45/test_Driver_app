import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Geolocation from '@react-native-community/geolocation';
import LoginScreen from "./src/LoginScreen";
import Screen1 from "./src/Screen1";
import ActiveRideScreen from "./src/ActiveRideScreen";
import RejectRideScreen from "./src/RejectRideScreen";
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import api from "./utils/api";

export type RootStackParamList = {
  LoginScreen: undefined;
  Screen1: { driverId: string; driverName: string; latitude: number; longitude: number };
  ActiveRideScreen: { rideId: string };
  RejectRideScreen: { rideId: string };
};

const id: string = uuidv4();
console.log("App UUID:", id);

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [initialRoute, setInitialRoute] = useState<string | null>(null);

  // Check for stored token on app launch
  useEffect(() => {
    const checkAuth = async () => {
      try {
        console.log("🔍 Checking for stored auth token...");
        const token = await AsyncStorage.getItem("authToken");
        const driverId = await AsyncStorage.getItem("driverId");
        const driverName = await AsyncStorage.getItem("driverName");

        if (token && driverId && driverName) {
          console.log("✅ Token found, navigating to Screen1");
          
          // Skip verification since endpoint returns 404
          setInitialRoute("Screen1");
          
          // Store initial navigation params (location will be handled in Screen1)
          await AsyncStorage.setItem(
            "initialParams",
            JSON.stringify({
              driverId,
              driverName,
              latitude: 0, // Default values, will be updated in Screen1
              longitude: 0,
            })
          );
        } else {
          console.log("❌ No token found, showing LoginScreen");
          setInitialRoute("LoginScreen");
        }
      } catch (err: any) {
        console.error("❌ Error checking auth:", err);
        
        // Don't clear storage for 404 errors
        if (err.response && err.response.status === 404) {
          console.log("⚠️ 404 error - proceeding with stored credentials");
          const driverId = await AsyncStorage.getItem("driverId");
          const driverName = await AsyncStorage.getItem("driverName");
          
          if (driverId && driverName) {
            setInitialRoute("Screen1");
            await AsyncStorage.setItem(
              "initialParams",
              JSON.stringify({
                driverId,
                driverName,
                latitude: 0,
                longitude: 0,
              })
            );
          } else {
            setInitialRoute("LoginScreen");
          }
        } else {
          // For other errors, clear storage and go to login
          await AsyncStorage.clear();
          setInitialRoute("LoginScreen");
        }
      }
    };

    checkAuth();
  }, []);

  if (!initialRoute) {
    return null; // Render nothing until auth check is complete
  }

  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName={initialRoute}>
        <Stack.Screen
          name="LoginScreen"
          component={LoginScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Screen1"
          component={Screen1}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="ActiveRideScreen"
          component={ActiveRideScreen}
          options={{ title: "Active Ride" }}
        />
        <Stack.Screen
          name="RejectRideScreen"
          component={RejectRideScreen}
          options={{ title: "Reject Ride" }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}




// import React from "react";
// import { NavigationContainer } from "@react-navigation/native";
// import { createNativeStackNavigator } from "@react-navigation/native-stack";
// import LoginScreen from "./src/LoginScreen";
// import Screen1 from "./src/Screen1";
// import ActiveRideScreen from "./src/ActiveRideScreen";
// import RejectRideScreen from "./src/RejectRideScreen";

// import 'react-native-get-random-values';
// import { v4 as uuidv4 } from 'uuid';

// export type RootStackParamList = {
//   LoginScreen: undefined;
//   Screen1: { isNewUser?: boolean; phone?: string };
//   ActiveRideScreen: { rideId: string };
//   RejectRideScreen: { rideId: string };
// };

// const id: string = uuidv4();
// console.log("App UUID:", id);

// const Stack = createNativeStackNavigator<RootStackParamList>();

// export default function App() {
//   return (
//     <NavigationContainer>
//       <Stack.Navigator initialRouteName="LoginScreen">
//         <Stack.Screen 
//           name="LoginScreen" 
//           component={LoginScreen} 
//           options={{ headerShown: false }} 
//         />
//         <Stack.Screen 
//           name="Screen1" 
//           component={Screen1} 
//           options={{ headerShown: false }} 
//         />
//         <Stack.Screen 
//           name="ActiveRideScreen" 
//           component={ActiveRideScreen} 
//           options={{ title: "Active Ride" }} 
//         />
//         <Stack.Screen 
//           name="RejectRideScreen" 
//           component={RejectRideScreen} 
//           options={{ title: "Reject Ride" }} 
//         />
//       </Stack.Navigator>
//     </NavigationContainer>
//   );
// }
