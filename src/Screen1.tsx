import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  PermissionsAndroid,
  Platform,
  Alert,
  Modal,
  TextInput,
  Dimensions,
} from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";
import Geolocation from "@react-native-community/geolocation";
import socket from "./socket";
import haversine from "haversine-distance";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "./apiConfig";
import api from "../utils/api";

const { width, height } = Dimensions.get("window");

type LocationType = { latitude: number; longitude: number };
type RideType = {
  rideId: string;
  RAID_ID?: string;
  otp?: string;
  pickup: LocationType & { address?: string };
  drop: LocationType & { address?: string };
  routeCoords?: LocationType[];
  fare?: number;
  distance?: string;
};
type UserDataType = {
  name: string;
  mobile: string;
  location: LocationType;
  userId?: string;
};

const DriverScreen = ({ route, navigation }: { route: any; navigation: any }) => {
  const [location, setLocation] = useState<LocationType | null>(
    route.params?.latitude && route.params?.longitude
      ? { latitude: route.params.latitude, longitude: route.params.longitude }
      : null
  );
  const [ride, setRide] = useState<RideType | null>(null);
  const [userData, setUserData] = useState<UserDataType | null>(null);
  const [userLocation, setUserLocation] = useState<LocationType | null>(null);
  const [travelledKm, setTravelledKm] = useState(0);
  const [lastCoord, setLastCoord] = useState<LocationType | null>(null);
  const [otpModalVisible, setOtpModalVisible] = useState(false);
  const [enteredOtp, setEnteredOtp] = useState("");
  const [rideStatus, setRideStatus] = useState<
    "idle" | "onTheWay" | "accepted" | "started" | "completed"
  >("idle");
  const [isRegistered, setIsRegistered] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [driverStatus, setDriverStatus] = useState<
    "offline" | "online" | "onRide"
  >("offline");
  const [isLoading, setIsLoading] = useState(false);
  const mapRef = useRef<MapView | null>(null);
  const [driverId, setDriverId] = useState<string>(route.params?.driverId || "");
  const [driverName, setDriverName] = useState<string>(
    route.params?.driverName || ""
  );
  const [error, setError] = useState<string | null>(null);

  // Route handling states
  const [fullRouteCoords, setFullRouteCoords] = useState<LocationType[]>([]);
  const [visibleRouteCoords, setVisibleRouteCoords] = useState<LocationType[]>([]);
  const [nearestPointIndex, setNearestPointIndex] = useState(0);
  const [mapRegion, setMapRegion] = useState<any>(null);

  // Refs for optimization
  const isMounted = useRef(true);
  const locationUpdateCount = useRef(0);
  const mapAnimationInProgress = useRef(false);
  const navigationInterval = useRef<NodeJS.Timeout | null>(null);
  const lastLocationUpdate = useRef<LocationType | null>(null);
  const routeUpdateThrottle = useRef<NodeJS.Timeout | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
      if (navigationInterval.current) {
        clearInterval(navigationInterval.current);
      }
      if (routeUpdateThrottle.current) {
        clearTimeout(routeUpdateThrottle.current);
      }
    };
  }, []);

  // Load driver info and verify token on mount
  useEffect(() => {
    const loadDriverInfo = async () => {
      try {
        console.log("🔍 Loading driver info from AsyncStorage...");
        const storedDriverId = await AsyncStorage.getItem("driverId");
        const storedDriverName = await AsyncStorage.getItem("driverName");
        const token = await AsyncStorage.getItem("authToken");

        if (storedDriverId && storedDriverName && token) {
          setDriverId(storedDriverId);
          setDriverName(storedDriverName);

          // Skip token verification since endpoint returns 404
          console.log("✅ Token found, skipping verification (endpoint returns 404)");
          setDriverStatus("online");
          
          // If location is not available, try to get it
          if (!location) {
            try {
              const pos = await new Promise<Geolocation.GeoPosition>((resolve, reject) => {
                Geolocation.getCurrentPosition(resolve, reject, {
                  enableHighAccuracy: true,
                  timeout: 15000,
                  maximumAge: 0
                });
              });
              
              setLocation({
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              });
            } catch (locationError) {
              console.error("❌ Error getting location:", locationError);
              // Continue without location - it will be handled by location tracking
            }
          }
        } else {
          console.log("❌ No driver info or token found, navigating to LoginScreen");
          await AsyncStorage.clear();
          navigation.replace("LoginScreen");
        }
      } catch (error) {
        console.error("❌ Error loading driver info:", error);
        
        // Don't clear storage for 404 errors
        if (error.response && error.response.status === 404) {
          console.log("⚠️ 404 error - skipping verification, proceeding with stored credentials");
          const storedDriverId = await AsyncStorage.getItem("driverId");
          const storedDriverName = await AsyncStorage.getItem("driverName");
          
          if (storedDriverId && storedDriverName) {
            setDriverId(storedDriverId);
            setDriverName(storedDriverName);
            setDriverStatus("online");
          } else {
            await AsyncStorage.clear();
            navigation.replace("LoginScreen");
          }
        } else {
          // For other errors, clear storage and go to login
          await AsyncStorage.clear();
          navigation.replace("LoginScreen");
        }
      }
    };

    if (!driverId || !driverName) {
      loadDriverInfo();
    }
  }, [driverId, driverName, navigation, location]);

  // Request user location when ride is accepted
  useEffect(() => {
    if (rideStatus === "accepted" && ride?.rideId) {
      console.log("📍 Requesting initial user location for accepted ride");
      socket.emit("getUserDataForDriver", { rideId: ride.rideId });

      const intervalId = setInterval(() => {
        if (rideStatus === "accepted" || rideStatus === "started") {
          socket.emit("getUserDataForDriver", { rideId: ride.rideId });
        }
      }, 10000);

      return () => clearInterval(intervalId);
    }
  }, [rideStatus, ride?.rideId]);

  // Optimized location saving
  const saveLocationToDatabase = useCallback(
    async (location: LocationType) => {
      try {
        locationUpdateCount.current++;
        if (locationUpdateCount.current % 5 !== 0) {
          return;
        }

        const payload = {
          driverId,
          driverName: driverName || "Unknown Driver",
          latitude: location.latitude,
          longitude: location.longitude,
          vehicleType: "taxi",
          status: driverStatus === "onRide" ? "onRide" : "Live",
          rideId: driverStatus === "onRide" ? ride?.rideId : null,
          timestamp: new Date().toISOString(),
        };

        const response = await fetch(`${API_BASE}/driver-location/update`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await AsyncStorage.getItem("authToken")}`,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error("❌ Failed to save location:", errorText);
          return;
        }

        if (socket.connected) {
          socket.emit("driverLocationUpdate", {
            driverId,
            latitude: location.latitude,
            longitude: location.longitude,
            status: driverStatus === "onRide" ? "onRide" : "Live",
            rideId: driverStatus === "onRide" ? ride?.rideId : null,
          });
        }
      } catch (error) {
        console.error("❌ Error saving location to DB:", error);
      }
    },
    [driverId, driverName, driverStatus, ride?.rideId]
  );

  // Register driver with socket
  useEffect(() => {
    if (!isRegistered && driverId && location) {
      console.log("📝 Registering driver with socket:", driverId);
      socket.emit("registerDriver", {
        driverId,
        driverName,
        latitude: location.latitude,
        longitude: location.longitude,
        vehicleType: "taxi",
      });
      setIsRegistered(true);
      setDriverStatus("online");
    }
  }, [driverId, location, isRegistered, driverName]);

  // Route fetching
  const fetchRoute = useCallback(
    async (origin: LocationType, destination: LocationType) => {
      try {
        console.log("🗺️ Fetching route between:", {
          origin: { lat: origin.latitude, lng: origin.longitude },
          destination: { lat: destination.latitude, lng: destination.longitude },
        });

        const url = `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.routes && data.routes.length > 0) {
          const coords = data.routes[0].geometry.coordinates.map(
            ([lng, lat]: number[]) => ({
              latitude: lat,
              longitude: lng,
            })
          );

          console.log("✅ Route fetched, coordinates count:", coords.length);
          return coords;
        }
      } catch (error) {
        console.error("❌ Error fetching route:", error);
        return null;
      }
    },
    []
  );

  // Find nearest point on route
  const findNearestPointOnRoute = useCallback(
    (currentLocation: LocationType, routeCoords: LocationType[]) => {
      if (!routeCoords || routeCoords.length === 0) return null;

      let minDistance = Infinity;
      let nearestIndex = 0;

      for (let i = 0; i < routeCoords.length; i++) {
        const distance = haversine(currentLocation, routeCoords[i]);
        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = i;
        }
      }

      return { index: nearestIndex, distance: minDistance };
    },
    []
  );

  // Update visible route as driver moves
  const updateVisibleRoute = useCallback(() => {
    if (!location || !fullRouteCoords.length || rideStatus !== "started") {
      return;
    }

    const nearestPoint = findNearestPointOnRoute(location, fullRouteCoords);
    if (!nearestPoint) return;

    // Always update the visible route when driver moves
    const remainingRoute = fullRouteCoords.slice(nearestPoint.index);
    
    if (remainingRoute.length > 0) {
      // Add current location to make the route more accurate
      const updatedRoute = [location, ...remainingRoute];
      setVisibleRouteCoords(updatedRoute);
      setNearestPointIndex(nearestPoint.index);
    }
  }, [location, fullRouteCoords, rideStatus, findNearestPointOnRoute]);

  // Throttled route update
  const throttledUpdateVisibleRoute = useCallback(() => {
    if (routeUpdateThrottle.current) {
      clearTimeout(routeUpdateThrottle.current);
    }

    routeUpdateThrottle.current = setTimeout(() => {
      updateVisibleRoute();
    }, 500);
  }, [updateVisibleRoute]);

  // Smooth map animation
  const animateToLocation = useCallback(
    (targetLocation: LocationType, shouldIncludeUser: boolean = false) => {
      if (!mapRef.current || mapAnimationInProgress.current) return;

      mapAnimationInProgress.current = true;

      let region = {
        latitude: targetLocation.latitude,
        longitude: targetLocation.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      };

      if (shouldIncludeUser && userLocation && location) {
        const points = [location, userLocation, targetLocation];
        const lats = points.map((p) => p.latitude);
        const lngs = points.map((p) => p.longitude);

        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);

        const midLat = (minLat + maxLat) / 2;
        const midLng = (minLng + maxLng) / 2;
        const latDelta = (maxLat - minLat) * 1.2;
        const lngDelta = (maxLng - minLng) * 1.2;

        region = {
          latitude: midLat,
          longitude: midLng,
          latitudeDelta: Math.max(latDelta, 0.02),
          longitudeDelta: Math.max(lngDelta, 0.02),
        };
      }

      setMapRegion(region);
      mapRef.current.animateToRegion(region, 1000);

      setTimeout(() => {
        mapAnimationInProgress.current = false;
      }, 1000);
    },
    [userLocation, location]
  );

  // Start navigation (called after OTP verification)
// Start navigation (called after OTP verification)
const startNavigation = useCallback(async () => {
  if (!ride?.pickup || !ride?.drop) return;

  console.log("🚀 Starting navigation from pickup to drop location");
  
  try {
    const routeCoords = await fetchRoute(ride.pickup, ride.drop);
    if (routeCoords && routeCoords.length > 0) {
      console.log("✅ Navigation route fetched successfully:", routeCoords.length, "points");
      
      // Set the full route coordinates
      setFullRouteCoords(routeCoords);
      setVisibleRouteCoords(routeCoords);
      
      // Start the navigation interval
      if (navigationInterval.current) {
        clearInterval(navigationInterval.current);
      }
      
      navigationInterval.current = setInterval(() => {
        throttledUpdateVisibleRoute();
      }, 2000); // Update every 2 seconds for better performance
      
      console.log("🗺️ Navigation started with route updates from pickup to drop");
    }
  } catch (error) {
    console.error("❌ Error starting navigation:", error);
  }
}, [ride?.pickup, ride?.drop, fetchRoute, throttledUpdateVisibleRoute]);

  // Stop navigation
  const stopNavigation = useCallback(() => {
    console.log("🛑 Stopping navigation mode");
    if (navigationInterval.current) {
      clearInterval(navigationInterval.current);
      navigationInterval.current = null;
    }
  }, []);

  // Logout function
  const handleLogout = async () => {
    try {
      console.log("🚪 Initiating logout for driver:", driverId);
      await api.post("/drivers/logout");
      await AsyncStorage.clear();
      console.log("✅ AsyncStorage cleared");
      socket.disconnect();
      navigation.replace("LoginScreen");
      console.log("🧭 Navigated to LoginScreen");
    } catch (err) {
      console.error("❌ Error during logout:", err);
      Alert.alert("❌ Logout Error", "Failed to logout. Please try again.");
    }
  };

  // Accept ride
const acceptRide = async (rideId?: string) => {
  const currentRideId = rideId || ride?.rideId;

  if (!currentRideId) {
    Alert.alert("Error", "No ride ID available. Please try again.");
    return;
  }

  if (!driverId) {
    Alert.alert("Error", "Driver not properly registered.");
    return;
  }

  if (!socket.connected) {
    Alert.alert("Connection Error", "Reconnecting to server...");
    socket.connect();
    socket.once("connect", () => {
      setTimeout(() => acceptRide(currentRideId), 1000);
    });
    return;
  }

  setIsLoading(true);
  setRideStatus("accepted");
  setDriverStatus("onRide");

  socket.emit(
    "acceptRide",
    {
      rideId: currentRideId,
      driverId: driverId,
      driverName: driverName,
    },
    async (response: any) => {
      setIsLoading(false);

      if (!isMounted.current) return;

      if (response && response.success) {
        const userDataWithId = {
          name: response.userName || "User",
          mobile: response.userMobile || "N/A",
          location: {
            latitude: response.pickup.lat,
            longitude: response.pickup.lng,
          },
          userId: response.userId,
        };

        setUserData(userDataWithId);

        const initialUserLocation = {
          latitude: response.pickup.lat,
          longitude: response.pickup.lng,
        };

        setUserLocation(initialUserLocation);

        if (location) {
          // Generate route from driver to pickup location (GREEN ROUTE)
          try {
            const pickupRoute = await fetchRoute(location, initialUserLocation);
            if (pickupRoute) {
              setRide((prev) => prev ? { ...prev, routeCoords: pickupRoute } : null);
              console.log("✅ Driver to pickup route generated");
            }
          } catch (error) {
            console.error("❌ Error generating pickup route:", error);
          }
          
          animateToLocation(initialUserLocation, true);
        }

        socket.emit("driverAcceptedRide", {
          rideId: currentRideId,
          driverId: driverId,
          userId: response.userId,
          driverLocation: location,
        });

        setTimeout(() => {
          socket.emit("getUserDataForDriver", { rideId: currentRideId });
        }, 1000);
      }
    }
  );
};

  // Reject ride
  const rejectRide = (rideId?: string) => {
    const currentRideId = rideId || ride?.rideId;

    if (!currentRideId) return;

    setRide(null);
    setRideStatus("idle");
    setDriverStatus("online");
    setUserData(null);
    setUserLocation(null);
    setLastCoord(null);
    setFullRouteCoords([]);
    setVisibleRouteCoords([]);

    socket.emit("rejectRide", {
      rideId: currentRideId,
      driverId,
    });

    Alert.alert("Ride Rejected ❌", "You rejected the ride");
  };

  // Confirm OTP - This is where we start the navigation
// Confirm OTP - This is where we start the navigation
const confirmOTP = async () => {
  if (!ride) return;

  if (!ride.otp) {
    Alert.alert("Error", "OTP not yet received. Please wait...");
    return;
  }

  if (enteredOtp === ride.otp) {
    setRideStatus("started");
    setOtpModalVisible(false);
    setEnteredOtp(""); // Clear OTP input

    console.log("✅ OTP Verified - Starting navigation from pickup to drop location");

    if (ride.pickup && ride.drop) {
      // Start navigation after OTP verification (from pickup to drop)
      await startNavigation();
      animateToLocation(ride.drop, true);
    }

    socket.emit("driverStartedRide", {
      rideId: ride.rideId,
      driverId: driverId,
      userId: userData?.userId,
      driverLocation: location,
    });

    Alert.alert(
      "OTP Verified ✅",
      "Navigation from pickup to destination started. Follow the red route.",
      [{ text: "OK" }]
    );
  } else {
    Alert.alert("Invalid OTP", "Please check the OTP and try again.");
  }
};

  // Complete ride
  const completeRide = () => {
    if (!ride) return;

    stopNavigation();

    setRideStatus("completed");
    setDriverStatus("online");

    socket.emit("driverCompletedRide", {
      rideId: ride.rideId,
      driverId: driverId,
      userId: userData?.userId,
      distance: travelledKm,
    });

    socket.emit("completeRide", {
      rideId: ride.rideId,
      driverId,
      distance: travelledKm,
    });

    Alert.alert("Ride Completed", `You travelled ${travelledKm.toFixed(2)} km.`);

    setRide(null);
    setTravelledKm(0);
    setUserData(null);
    setUserLocation(null);
    setLastCoord(null);
    setFullRouteCoords([]);
    setVisibleRouteCoords([]);
    setNearestPointIndex(0);
  };

  // Location tracking
  useEffect(() => {
    let watchId: number | null = null;

    const requestLocation = async () => {
      try {
        if (Platform.OS === "android" && !location) {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            {
              title: "Location Permission",
              message: "This app needs access to your location to track rides",
              buttonNeutral: "Ask Me Later",
              buttonNegative: "Cancel",
              buttonPositive: "OK",
            }
          );

          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            Alert.alert(
              "Permission Denied",
              "Location permission is required for this app to work"
            );
            return;
          }
        }

        if (!location) return;

        watchId = Geolocation.watchPosition(
          (pos) => {
            if (!isMounted.current) return;

            const loc: LocationType = {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
            };

            setLocation(loc);

            lastLocationUpdate.current = loc;

            if (locationUpdateCount.current % 10 === 0 && mapRef.current && !ride) {
              mapRef.current.animateToRegion(
                {
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  latitudeDelta: 0.01,
                  longitudeDelta: 0.01,
                },
                500
              );
            }

            if (lastCoord) {
              const dist = haversine(lastCoord, loc);
              setTravelledKm((prev) => prev + dist / 1000);
            }
            setLastCoord(loc);

            saveLocationToDatabase(loc).catch(console.error);
          },
          (err) => {
            console.error("❌ Geolocation error:", err);
            Alert.alert(
              "Location Error",
              "Could not get your location. Please check your GPS settings and location permissions."
            );
          },
          {
            enableHighAccuracy: true,
            distanceFilter: 10,
            interval: 5000,
            fastestInterval: 3000,
            timeout: 15000,
          }
        );
      } catch (error) {
        console.error("❌ Error setting up location tracking:", error);
        Alert.alert("Setup Error", "Failed to initialize location tracking");
      }
    };

    requestLocation();

    return () => {
      if (watchId !== null) {
        Geolocation.clearWatch(watchId);
      }
    };
  }, [location, saveLocationToDatabase]);

  // Socket event listeners
  useEffect(() => {
    const handleConnect = () => {
      if (!isMounted.current) return;
      setSocketConnected(true);

      if (location && driverId) {
        socket.emit("registerDriver", {
          driverId,
          driverName,
          latitude: location.latitude,
          longitude: location.longitude,
          vehicleType: "taxi",
        });
        setIsRegistered(true);
        setDriverStatus("online");
      }
    };

    const handleRideRequest = (data: any) => {
      if (!isMounted.current || !data?.rideId) return;

      try {
        const rideData: RideType = {
          rideId: data.rideId,
          RAID_ID: data.RAID_ID || "N/A",
          otp: data.otp || "0000",
          pickup: {
            latitude: data.pickup?.lat || data.pickup?.latitude || 0,
            longitude: data.pickup?.lng || data.pickup?.longitude || 0,
            address: data.pickup?.address || "Unknown location",
          },
          drop: {
            latitude: data.drop?.lat || data.drop?.latitude || 0,
            longitude: data.drop?.lng || data.drop?.longitude || 0,
            address: data.drop?.address || "Unknown location",
          },
          fare: data.fare || 0,
          distance: data.distance || "0 km",
        };

        setRide(rideData);
        setRideStatus("onTheWay");

        Alert.alert(
          "🚖 New Ride Request!",
          `📍 Pickup: ${rideData.pickup.address}\n🎯 Drop: ${rideData.drop.address}\n💰 Fare: ₹${rideData.fare}\n📏 Distance: ${rideData.distance}`,
          [
            {
              text: "❌ Reject",
              onPress: () => rejectRide(rideData.rideId),
              style: "destructive",
            },
            {
              text: "✅ Accept",
              onPress: () => acceptRide(rideData.rideId),
            },
          ],
          { cancelable: false }
        );
      } catch (error) {
        console.error("❌ Error processing ride request:", error);
        Alert.alert("Error", "Could not process ride request. Please try again.");
      }
    };

    const handleUserLiveLocationUpdate = (data: any) => {
      if (!isMounted.current) return;

      if (data && typeof data.lat === "number" && typeof data.lng === "number") {
        const newUserLocation = {
          latitude: data.lat,
          longitude: data.lng,
        };

        setUserLocation((prev) => {
          if (
            !prev ||
            prev.latitude !== newUserLocation.latitude ||
            prev.longitude !== newUserLocation.longitude
          ) {
            return newUserLocation;
          }
          return prev;
        });

        setUserData((prev) => {
          if (prev) {
            return { ...prev, location: newUserLocation };
          }
          return prev;
        });
      }
    };

    const handleUserDataForDriver = (data: any) => {
      if (!isMounted.current) return;

      if (data && data.userCurrentLocation) {
        const userLiveLocation = {
          latitude: data.userCurrentLocation.latitude,
          longitude: data.userCurrentLocation.longitude,
        };

        setUserLocation(userLiveLocation);

        if (userData && !userData.userId && data.userId) {
          setUserData((prev) => (prev ? { ...prev, userId: data.userId } : null));
        }
      }
    };

    const handleRideOTP = (data: any) => {
      if (!isMounted.current) return;

      if (ride && ride.rideId === data.rideId) {
        setRide((prev) => (prev ? { ...prev, otp: data.otp } : null));
      }
    };

    const handleDisconnect = () => {
      if (!isMounted.current) return;
      setSocketConnected(false);
      setIsRegistered(false);
      setDriverStatus("offline");
      if (ride) {
        setUserData(null);
        setUserLocation(null);
        Alert.alert("Connection Lost", "Reconnecting to server...");
      }
    };

    const handleConnectError = (error: Error) => {
      if (!isMounted.current) return;
      setSocketConnected(false);
      setError("Failed to connect to server");
    };

    const handleRideCancelled = (data: any) => {
      if (!isMounted.current) return;

      if (ride && ride.rideId === data.rideId) {
        stopNavigation();

        socket.emit("driverRideCancelled", {
          rideId: ride.rideId,
          driverId: driverId,
          userId: userData?.userId,
        });

        setRide(null);
        setUserData(null);
        setUserLocation(null);
        setTravelledKm(0);
        setLastCoord(null);
        setRideStatus("idle");
        setDriverStatus("online");
        setFullRouteCoords([]);
        setVisibleRouteCoords([]);
        setNearestPointIndex(0);
        Alert.alert("Ride Cancelled", "The passenger cancelled the ride.");
      }
    };

    const handleRideAlreadyAccepted = (data: any) => {
      if (!isMounted.current) return;

      if (ride && ride.rideId === data.rideId) {
        setRide(null);
        setUserData(null);
        setUserLocation(null);
        setTravelledKm(0);
        setLastCoord(null);
        setRideStatus("idle");
        setDriverStatus("online");
        Alert.alert(
          "Ride Taken",
          data.message || "This ride has already been accepted by another driver."
        );
      }
    };

    socket.on("connect", handleConnect);
    socket.on("newRideRequest", handleRideRequest);
    socket.on("userLiveLocationUpdate", handleUserLiveLocationUpdate);
    socket.on("userDataForDriver", handleUserDataForDriver);
    socket.on("rideOTP", handleRideOTP);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("rideCancelled", handleRideCancelled);
    socket.on("rideAlreadyAccepted", handleRideAlreadyAccepted);

    if (!socket.connected) {
      socket.connect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("newRideRequest", handleRideRequest);
      socket.off("userLiveLocationUpdate", handleUserLiveLocationUpdate);
      socket.off("userDataForDriver", handleUserDataForDriver);
      socket.off("rideOTP", handleRideOTP);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("rideCancelled", handleRideCancelled);
      socket.off("rideAlreadyAccepted", handleRideAlreadyAccepted);
    };
  }, [location, driverId, driverName, ride, rideStatus, userData, stopNavigation]);

  // UI Rendering
  if (error) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => setError(null)}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!location) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4caf50" />
        <Text style={styles.loadingText}>Fetching your location...</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => {
            Geolocation.getCurrentPosition(
              (pos) => {
                setLocation({
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                });
              },
              (err) => {
                Alert.alert(
                  "Location Error",
                  "Could not get your location. Please check GPS settings."
                );
              },
              { enableHighAccuracy: true, timeout: 15000 }
            );
          }}
        >
          <Text style={styles.retryText}>Retry Location</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{
          latitude: location.latitude,
          longitude: location.longitude,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
        showsUserLocation
        showsMyLocationButton
        showsCompass={true}
        showsScale={true}
        zoomControlEnabled={true}
        rotateEnabled={true}
        scrollEnabled={true}
        zoomEnabled={true}
        region={mapRegion}
      >
        {ride && (
          <Marker
            coordinate={ride.pickup}
            title="Pickup Location"
            description={ride.pickup.address}
            pinColor="blue"
          />
        )}
        {ride && (
          <Marker
            coordinate={ride.drop}
            title="Drop Location"
            description={ride.drop.address}
            pinColor="red"
          />
        )}
        
        {/* RED ROUTE - Show after OTP verification (ride started) */}
        {rideStatus === "started" && visibleRouteCoords.length > 0 && (
          <Polyline
            coordinates={visibleRouteCoords}
            strokeWidth={6}
            strokeColor="#F44336"
            lineCap="round"
            lineJoin="round"
          />
        )}
        
        {/* GREEN ROUTE - Show from driver to pickup location (before OTP) */}
        {rideStatus === "accepted" && ride?.routeCoords && ride.routeCoords.length > 0 && (
          <Polyline
            coordinates={ride.routeCoords}
            strokeWidth={4}
            strokeColor="#4caf50"
            lineCap="round"
            lineJoin="round"
          />
        )}
        
        {ride && (rideStatus === "accepted" || rideStatus === "started") && userLocation && (
          <Marker
            coordinate={userLocation}
            title="User Live Location"
            description={`${userData?.name || "User"} - Live Location`}
            tracksViewChanges={false}
          >
            <View style={styles.blackDotMarker}>
              <View style={styles.blackDotInner} />
            </View>
          </Marker>
        )}
      </MapView>

      <View style={styles.statusContainer}>
        <View style={styles.statusRow}>
          <View
            style={[
              styles.statusIndicator,
              { backgroundColor: socketConnected ? "#4caf50" : "#f44336" },
            ]}
          />
          <Text style={styles.statusText}>
            {socketConnected ? "Connected" : "Disconnected"}
          </Text>
          <View
            style={[
              styles.statusIndicator,
              {
                backgroundColor:
                  driverStatus === "online"
                    ? "#4caf50"
                    : driverStatus === "onRide"
                    ? "#ff9800"
                    : "#f44336",
              },
            ]}
          />
          <Text style={styles.statusText}>{driverStatus.toUpperCase()}</Text>
        </View>
        {ride && (rideStatus === "accepted" || rideStatus === "started") && userLocation && (
          <Text style={styles.userLocationText}>
            🟢 User Live: {userLocation.latitude.toFixed(4)},{" "}
            {userLocation.longitude.toFixed(4)}
          </Text>
        )}
      </View>

      {ride && (rideStatus === "accepted" || rideStatus === "started") && userData && (
        <View style={styles.userDataContainer}>
          <Text style={styles.userDataTitle}>Passenger Details</Text>
          <View style={styles.userInfoRow}>
            <Text style={styles.userInfoLabel}>Name:</Text>
            <Text style={styles.userInfoValue}>{userData.name}</Text>
          </View>
          <View style={styles.userInfoRow}>
            <Text style={styles.userInfoLabel}>Mobile:</Text>
            <Text style={styles.userInfoValue}>{userData.mobile}</Text>
          </View>
          <View style={styles.userInfoRow}>
            <Text style={styles.userInfoLabel}>Pickup:</Text>
            <Text style={styles.userInfoValue} numberOfLines={2}>
              {ride.pickup.address}
            </Text>
          </View>
          <View style={styles.userInfoRow}>
            <Text style={styles.userInfoLabel}>Drop:</Text>
            <Text style={styles.userInfoValue} numberOfLines={2}>
              {ride.drop.address}
            </Text>
          </View>
          {userLocation && (
            <View style={styles.liveStatus}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE LOCATION TRACKING ACTIVE</Text>
            </View>
          )}
        </View>
      )}

      {ride && rideStatus === "onTheWay" && (
        <View style={styles.rideActions}>
          <TouchableOpacity
            style={[styles.button, styles.acceptButton]}
            onPress={() => acceptRide()}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>Accept Ride</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.button, styles.rejectButton]}
            onPress={() => rejectRide()}
          >
            <Text style={styles.btnText}>Reject</Text>
          </TouchableOpacity>
        </View>
      )}

      {ride && rideStatus === "accepted" && (
        <TouchableOpacity
          style={[styles.button, styles.startButton]}
          onPress={() => setOtpModalVisible(true)}
        >
          <Text style={styles.btnText}>Enter OTP & Start Ride</Text>
        </TouchableOpacity>
      )}

      {ride && rideStatus === "started" && (
        <TouchableOpacity
          style={[styles.button, styles.completeButton]}
          onPress={completeRide}
        >
          <Text style={styles.btnText}>
            Complete Ride ({travelledKm.toFixed(2)} km)
          </Text>
        </TouchableOpacity>
      )}

      {/* Logout Button */}
      {!ride && (
        <TouchableOpacity
          style={[styles.button, styles.logoutButton]}
          onPress={handleLogout}
        >
          <Text style={styles.btnText}>Logout</Text>
        </TouchableOpacity>
      )}

      <Modal visible={otpModalVisible} transparent animationType="slide">
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Enter OTP</Text>
            <Text style={styles.modalSubtitle}>Please ask passenger for OTP</Text>
            <TextInput
              placeholder="Enter 4-digit OTP"
              value={enteredOtp}
              onChangeText={setEnteredOtp}
              keyboardType="numeric"
              style={styles.input}
              maxLength={4}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={() => setOtpModalVisible(false)}
              >
                <Text style={styles.btnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.confirmButton]}
                onPress={confirmOTP}
              >
                <Text style={styles.btnText}>Confirm OTP</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

export default DriverScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f8f9fa",
  },
  map: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
    padding: 20,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: "#666",
    textAlign: "center",
  },
  statusContainer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 50 : 40,
    left: 16,
    right: 16,
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    padding: 12,
    borderRadius: 12,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: "600",
    marginRight: 16,
    color: "#333",
  },
  userLocationText: {
    fontSize: 11,
    color: "#4caf50",
    fontWeight: "500",
    marginTop: 2,
  },
  rideActions: {
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  button: {
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    elevation: 3,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    flex: 1,
  },
  acceptButton: {
    backgroundColor: "#4caf50",
  },
  rejectButton: {
    backgroundColor: "#f44336",
  },
  startButton: {
    backgroundColor: "#2196f3",
    margin: 16,
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
  },
  completeButton: {
    backgroundColor: "#ff9800",
    margin: 16,
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
  },
  cancelButton: {
    backgroundColor: "#757575",
  },
  confirmButton: {
    backgroundColor: "#4caf50",
  },
  logoutButton: {
    backgroundColor: "#dc3545",
    margin: 16,
    position: "absolute",
    bottom: 20,
    left: 16,
    right: 16,
  },
  btnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  modalContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: 20,
  },
  modalContent: {
    backgroundColor: "white",
    padding: 24,
    borderRadius: 16,
    width: "100%",
    elevation: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
    textAlign: "center",
    color: "#333",
  },
  modalSubtitle: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    marginBottom: 20,
  },
  input: {
    borderWidth: 2,
    borderColor: "#e0e0e0",
    borderRadius: 8,
    marginVertical: 16,
    padding: 16,
    fontSize: 18,
    textAlign: "center",
    fontWeight: "600",
    backgroundColor: "#f8f9fa",
  },
  modalButtons: {
    flexDirection: "row",
    marginTop: 8,
    gap: 12,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    color: "#f44336",
    marginBottom: 20,
    textAlign: "center",
    lineHeight: 22,
  },
  retryButton: {
    backgroundColor: "#4caf50",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    elevation: 2,
  },
  retryText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
  blackDotMarker: {
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
  blackDotInner: {
    backgroundColor: "#000000",
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  userDataContainer: {
    position: "absolute",
    bottom: 80,
    left: 16,
    right: 16,
    backgroundColor: "#FFFFFF",
    padding: 16,
    borderRadius: 16,
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
  },
  userDataTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 12,
    color: "#333",
  },
  userInfoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  userInfoLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#666",
    width: 60,
    marginRight: 8,
  },
  userInfoValue: {
    fontSize: 14,
    color: "#333",
    flex: 1,
    lineHeight: 20,
  },
  liveStatus: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#4caf50",
    marginRight: 8,
  },
  liveText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#4caf50",
  },
});

