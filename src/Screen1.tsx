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


// import React, { useState, useEffect, useRef, useCallback } from "react";
// import {
//   View,
//   Text,
//   TouchableOpacity,
//   StyleSheet,
//   ActivityIndicator,
//   PermissionsAndroid,
//   Platform,
//   Alert,
//   Modal,
//   TextInput,
//   StatusBar,
// } from "react-native";
// import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
// import Geolocation from "@react-native-community/geolocation";
// import socket from "./socket";
// import haversine from "haversine-distance";
// import AsyncStorage from "@react-native-async-storage/async-storage";
// import { API_BASE } from "./apiConfig";

// type LocationType = { latitude: number; longitude: number };
// type RideType = {
//   rideId: string;
//   RAID_ID?: string;
//   otp?: string;
//   pickup: LocationType & { address?: string };
//   drop: LocationType & { address?: string };
//   routeCoords?: LocationType[];
//   fare?: number;
//   distance?: string;
// };
// type UserDataType = {
//   name: string;
//   mobile: string;
//   location: LocationType;
//   userId?: string;
// };

// // User location tracking storage
// const userLocationTracking = new Map();

// const DriverScreen = ({ route, navigation }: { route: any; navigation: any }) => {
//   const [location, setLocation] = useState<LocationType | null>(
//     route.params?.latitude && route.params?.longitude
//       ? { latitude: route.params.latitude, longitude: route.params.longitude }
//       : null
//   );
//   const [ride, setRide] = useState<RideType | null>(null);
//   const [userData, setUserData] = useState<UserDataType | null>(null);
//   const [userLocation, setUserLocation] = useState<LocationType | null>(null);
//   const [travelledKm, setTravelledKm] = useState(0);
//   const [lastCoord, setLastCoord] = useState<LocationType | null>(null);
//   const [otpModalVisible, setOtpModalVisible] = useState(false);
//   const [enteredOtp, setEnteredOtp] = useState("");
//   const [rideStatus, setRideStatus] = useState<
//     "idle" | "onTheWay" | "accepted" | "started" | "completed"
//   >("idle");
//   const [isRegistered, setIsRegistered] = useState(false);
//   const [socketConnected, setSocketConnected] = useState(false);
//   const [driverStatus, setDriverStatus] = useState<
//     "offline" | "online" | "onRide"
//   >("offline");
//   const mapRef = useRef<MapView | null>(null);
//   const [driverId, setDriverId] = useState<string>(route.params?.driverId || "");
//   const [driverName, setDriverName] = useState<string>(route.params?.driverName || "");
//   const [error, setError] = useState<string | null>(null);
//   const [initialRegionSet, setInitialRegionSet] = useState(false);
//   const [locationUpdateCounter, setLocationUpdateCounter] = useState(0);

//   // Refs for preventing state updates on unmounted component
//   const isMounted = useRef(true);
//   const locationWatchId = useRef<number | null>(null);
//   const userLocationInterval = useRef<NodeJS.Timeout | null>(null);

//   // Console log for component initialization
//   console.log("🚗 DriverScreen component initialized");

//   // Set up isMounted ref
//   useEffect(() => {
//     return () => {
//       isMounted.current = false;
//       if (locationWatchId.current !== null) {
//         Geolocation.clearWatch(locationWatchId.current);
//       }
//       if (userLocationInterval.current) {
//         clearInterval(userLocationInterval.current);
//       }
//     };
//   }, []);

//   // Request user location when ride is accepted
//   useEffect(() => {
//     if (rideStatus === "accepted" && ride?.rideId) {
//       console.log("📍 Requesting initial user location for accepted ride");
//       socket.emit("getUserDataForDriver", { rideId: ride.rideId });
      
//       // Set up interval to request user location periodically
//       userLocationInterval.current = setInterval(() => {
//         if (rideStatus === "accepted" || rideStatus === "started") {
//           socket.emit("getUserDataForDriver", { rideId: ride.rideId });
//         }
//       }, 10000); // Request every 10 seconds

//       return () => {
//         if (userLocationInterval.current) {
//           clearInterval(userLocationInterval.current);
//           userLocationInterval.current = null;
//         }
//       };
//     }
//   }, [rideStatus, ride?.rideId]);

//   // Update the saveLocationToDatabase function
//   const saveLocationToDatabase = async (location: LocationType) => {
//     try {
//       console.log("💾 Saving location to DB for driver:", driverId);

//       const payload = {
//         driverId,
//         driverName: driverName || "Unknown Driver",
//         latitude: location.latitude,
//         longitude: location.longitude,
//         vehicleType: "taxi",
//         status: driverStatus === "onRide" ? "onRide" : "Live",
//         timestamp: new Date().toISOString(),
//       };

//       console.log("📤 Sending location payload:", payload);

//       const response = await fetch(`${API_BASE}/driver-location/update`, {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           Authorization: `Bearer ${await AsyncStorage.getItem("authToken")}`,
//         },
//         body: JSON.stringify(payload),
//       });

//       if (!response.ok) {
//         const errorText = await response.text();
//         console.error("❌ Failed to save location:", {
//           status: response.status,
//           message: errorText,
//         });

//         if (response.status >= 500) {
//           throw new Error(`Server error: ${response.status}`);
//         }
//         return;
//       }

//       const responseData = await response.json();
//       console.log("✅ Location saved successfully:", responseData);

//       if (socket.connected) {
//         socket.emit("driverLocationUpdate", {
//           driverId,
//           latitude: location.latitude,
//           longitude: location.longitude,
//           status: driverStatus === "onRide" ? "onRide" : "Live",
//         });
//       }
//     } catch (error) {
//       console.error("❌ Error saving location to DB:", error.message || error);

//       if (error.message.includes("Server error") || error.message.includes("Network")) {
//         if (isMounted.current) {
//           Alert.alert("Sync Error", "Having trouble updating your location. Some features may be affected.");
//         }
//       }
//     }
//   };

//   // Register driver if not registered and location/driverId is available
//   useEffect(() => {
//     console.log("🔍 Driver registration check:", {
//       isRegistered,
//       hasDriverId: !!driverId,
//       hasLocation: !!location,
//     });

//     if (!isRegistered && driverId && location) {
//       console.log("📝 Registering driver with socket:", driverId);
//       socket.emit("registerDriver", {
//         driverId,
//         driverName,
//         latitude: location.latitude,
//         longitude: location.longitude,
//         vehicleType: "taxi",
//       });
//       setIsRegistered(true);
//       setDriverStatus("online");
//       console.log("✅ Driver registration emitted, status set to online");
//     }
//   }, [driverId, location, isRegistered, driverName]);

//   // Load driver info from AsyncStorage
//   useEffect(() => {
//     const loadDriverInfo = async () => {
//       try {
//         console.log("📂 Loading driver info from AsyncStorage...");
//         const storedDriverId = await AsyncStorage.getItem("driverId");
//         const storedDriverName = await AsyncStorage.getItem("driverName");

//         console.log("📋 Retrieved driver info:", {
//           driverId: storedDriverId,
//           driverName: storedDriverName,
//         });

//         if (!driverId && storedDriverId) setDriverId(storedDriverId);
//         if (!driverName && storedDriverName) setDriverName(storedDriverName);

//         console.log("✅ Driver info loaded successfully");
//       } catch (error) {
//         console.error("❌ Error loading driver info:", error);
//       }
//     };
//     if (!driverId || !driverName) loadDriverInfo();
//   }, [driverId, driverName]);

//   const fetchRoute = async (origin: LocationType, destination: LocationType) => {
//     try {
//       console.log("🗺️ Fetching route between:", {
//         origin: { lat: origin.latitude, lng: origin.longitude },
//         destination: { lat: destination.latitude, lng: destination.longitude },
//       });

//       const url = `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`;
//       const response = await fetch(url);
//       const data = await response.json();

//       if (data.routes && data.routes.length > 0) {
//         const coords = data.routes[0].geometry.coordinates.map(
//           ([lng, lat]: number[]) => ({
//             latitude: lat,
//             longitude: lng,
//           })
//         );

//         console.log("✅ Route fetched successfully, coordinates count:", coords.length);
//         setRide((prev) => (prev ? { ...prev, routeCoords: coords } : null));
        
//         // Only fit to markers once when route is fetched, not on every update
//         if (mapRef.current && !initialRegionSet) {
//           setTimeout(() => {
//             if (mapRef.current && isMounted.current) {
//               mapRef.current.fitToCoordinates([origin, destination], {
//                 edgePadding: { top: 100, right: 100, bottom: 300, left: 100 },
//                 animated: true,
//               });
//               setInitialRegionSet(true);
//             }
//           }, 500);
//         }
//       } else {
//         console.error("❌ No routes found in response");
//       }
//     } catch (error) {
//       console.error("❌ Error fetching route:", error);
//     }
//   };

//   const acceptRide = async (rideId?: string) => {
//     const currentRideId = rideId || ride?.rideId;

//     console.log("🚨 ===== ACCEPT RIDE DEBUG START =====");
//     console.log("📋 Ride Data:", {
//       rideId: currentRideId,
//       hasRideObject: !!ride,
//       rideStatus: rideStatus,
//       driverId: driverId,
//       driverName: driverName,
//       socketConnected: socket.connected,
//       socketId: socket.id,
//       isMounted: isMounted.current,
//     });
//     console.log("🚨 ===== ACCEPT RIDE DEBUG END =====");

//     // Validation checks
//     if (!currentRideId) {
//       console.error("❌ CRITICAL: No ride ID available");
//       Alert.alert("Error", "No ride ID available. Please try again.");
//       return;
//     }

//     if (!driverId) {
//       console.error("❌ CRITICAL: No driver ID");
//       Alert.alert("Error", "Driver not properly registered.");
//       return;
//     }

//     if (!socket.connected) {
//       console.error("❌ CRITICAL: Socket not connected");
//       Alert.alert("Connection Error", "Reconnecting to server...");
//       socket.connect();

//       socket.once("connect", () => {
//         console.log("✅ Socket reconnected, retrying accept");
//         setTimeout(() => acceptRide(currentRideId), 1000);
//       });
//       return;
//     }

//     setRideStatus("accepted");
//     setDriverStatus("onRide");

//     const emitAcceptRide = (attempt = 1) => {
//       console.log(`📡 Emitting acceptRide (Attempt ${attempt}):`, {
//         rideId: currentRideId,
//         driverId: driverId,
//         driverName: driverName,
//       });

//       socket.emit(
//         "acceptRide",
//         {
//           rideId: currentRideId,
//           driverId: driverId,
//           driverName: driverName,
//         },
//         (response: any) => {
//           console.log(`📨 ACCEPT RIDE RESPONSE (Attempt ${attempt}):`, response);

//           if (!isMounted.current) {
//             console.log("⚠️ Component unmounted, ignoring response");
//             return;
//           }

//           if (response && response.success) {
//             console.log("🎉 RIDE ACCEPTED SUCCESSFULLY!");

//             const userDataWithId = {
//               name: response.userName || "User",
//               mobile: response.userMobile || "N/A",
//               location: {
//                 latitude: response.pickup.lat,
//                 longitude: response.pickup.lng,
//               },
//               userId: response.userId,
//             };

//             setUserData(userDataWithId);

//             const initialUserLocation = {
//               latitude: response.pickup.lat,
//               longitude: response.pickup.lng,
//             };

//             setUserLocation(initialUserLocation);

//             console.log("📍 Initial user location set to pickup:", initialUserLocation);

//             if (location) {
//               fetchRoute(location, initialUserLocation);
//             }

//             setTimeout(() => {
//               socket.emit("getUserDataForDriver", { rideId: currentRideId });
//             }, 1000);
//           } else if (response && response.error === "alreadyAccepted") {
//             console.log("⚠️ Ride already accepted by another driver");
//             Alert.alert(
//               "Ride Taken",
//               "This ride has already been accepted by another driver."
//             );
//             setRide(null);
//             setRideStatus("idle");
//             setDriverStatus("online");
//           }
//         }
//       );
//     };

//     emitAcceptRide(1);
//   };

//   const rejectRide = (rideId?: string) => {
//     const currentRideId = rideId || ride?.rideId;
//     console.log("👎 Rejecting ride:", {
//       rideId: currentRideId,
//       currentStatus: rideStatus,
//     });

//     if (!currentRideId) {
//       console.error("❌ No ride ID provided for rejection");
//       return;
//     }

//     setRide(null);
//     setRideStatus("idle");
//     setDriverStatus("online");
//     setUserData(null);
//     setUserLocation(null);
//     setLastCoord(null);
//     setInitialRegionSet(false);
//     console.log("📊 Status updated: idle, online");

//     console.log("📡 Emitting rejectRide event:", {
//       rideId: currentRideId,
//       driverId,
//     });

//     socket.emit("rejectRide", {
//       rideId: currentRideId,
//       driverId,
//     });

//     console.log("✅ Ride rejection emitted");
//     if (isMounted.current) {
//       Alert.alert("Ride Rejected ❌", "You rejected the ride");
//     }
//   };

//   const confirmOTP = async () => {
//     console.log("🔢 Confirming OTP:", {
//       enteredOTP: enteredOtp,
//       expectedOTP: ride?.otp,
//       rideId: ride?.rideId,
//     });

//     if (!ride) {
//       console.error("❌ No ride available to confirm OTP");
//       return;
//     }

//     if (!ride.otp) {
//       console.error("❌ No OTP available for this ride");
//       Alert.alert("Error", "OTP not yet received. Please wait...");
//       return;
//     }

//     if (enteredOtp === ride.otp) {
//       console.log("✅ OTP verification successful");
//       setRideStatus("started");
//       setOtpModalVisible(false);
//       setInitialRegionSet(false); // Reset for new route

//       if (location && ride.drop) {
//         console.log("🗺️ Fetching route to drop");
//         await fetchRoute(location, ride.drop);
//       }

//       Alert.alert("OTP Verified", "Ride started successfully!");
//     } else {
//       console.error("❌ OTP verification failed");
//       Alert.alert("Invalid OTP", "Please try again.");
//     }
//   };

//   const completeRide = () => {
//     console.log("🏁 Completing ride:", {
//       rideId: ride?.rideId,
//       distance: travelledKm,
//     });

//     if (!ride) {
//       console.error("❌ No ride available to complete");
//       return;
//     }

//     setRideStatus("completed");
//     setDriverStatus("online");
//     setInitialRegionSet(false);
//     console.log("📊 Status updated: completed, online");

//     console.log("📡 Emitting completeRide event:", {
//       rideId: ride.rideId,
//       driverId,
//       distance: travelledKm,
//     });

//     socket.emit("completeRide", {
//       rideId: ride.rideId,
//       driverId,
//       distance: travelledKm,
//     });

//     console.log("✅ Ride completion emitted");
//     if (isMounted.current) {
//       Alert.alert("Ride Completed", `You travelled ${travelledKm.toFixed(2)} km.`);
//     }

//     setRide(null);
//     setTravelledKm(0);
//     setUserData(null);
//     setUserLocation(null);
//     setLastCoord(null);
//   };

//   // Location Tracking
//   useEffect(() => {
//     console.log("📍 Setting up location tracking...");

//     const requestLocation = async () => {
//       try {
//         if (Platform.OS === "android" && !location) {
//           console.log("🔐 Requesting Android location permission...");
//           const granted = await PermissionsAndroid.request(
//             PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
//             {
//               title: "Location Permission",
//               message: "This app needs access to your location to track rides",
//               buttonNeutral: "Ask Me Later",
//               buttonNegative: "Cancel",
//               buttonPositive: "OK",
//             }
//           );

//           if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
//             console.error("❌ Location permission denied");
//             if (isMounted.current) {
//               Alert.alert("Permission Denied", "Location permission is required for this app to work");
//             }
//             return;
//           }
//           console.log("✅ Location permission granted");
//         }

//         if (!location) {
//           console.error("❌ No initial location available, cannot start watch");
//           return;
//         }

//         console.log("🔄 Starting location watch...");
//         locationWatchId.current = Geolocation.watchPosition(
//           (pos) => {
//             if (!isMounted.current) return;

//             const loc: LocationType = {
//               latitude: pos.coords.latitude,
//               longitude: pos.coords.longitude,
//             };

//             console.log(`📍 Driver location updated: lat=${loc.latitude.toFixed(6)}, lng=${loc.longitude.toFixed(6)}`);
//             setLocation(loc);
//             setLocationUpdateCounter(prev => prev + 1);

//             // Only update map region on significant location changes or every 10 updates
//             if (mapRef.current && (locationUpdateCounter % 10 === 0 || !lastCoord || 
//                 haversine(lastCoord, loc) > 100)) {
//               mapRef.current.animateToRegion(
//                 {
//                   latitude: loc.latitude,
//                   longitude: loc.longitude,
//                   latitudeDelta: 0.01,
//                   longitudeDelta: 0.01,
//                 },
//                 500
//               );
//             }

//             if (lastCoord) {
//               const dist = haversine(lastCoord, loc);
//               setTravelledKm((prev) => prev + dist / 1000);
//             }
//             setLastCoord(loc);

//             saveLocationToDatabase(loc).catch((error) => {
//               console.error("❌ Background location save failed:", error);
//             });
//           },
//           (err) => {
//             console.error("❌ Geolocation error:", err);
//             if (isMounted.current) {
//               Alert.alert(
//                 "Location Error",
//                 "Could not get your location. Please check your GPS settings and location permissions."
//               );
//             }
//           },
//           {
//             enableHighAccuracy: true,
//             distanceFilter: 10,
//             interval: 5000,
//             fastestInterval: 2000,
//             timeout: 20000,
//           }
//         );

//         console.log("✅ Location watch started successfully");
//       } catch (error) {
//         console.error("❌ Error setting up location tracking:", error);
//         if (isMounted.current) {
//           Alert.alert("Setup Error", "Failed to initialize location tracking");
//         }
//       }
//     };

//     requestLocation();

//     return () => {
//       console.log("🛑 Clearing location watch...");
//       if (locationWatchId.current !== null) {
//         Geolocation.clearWatch(locationWatchId.current);
//         locationWatchId.current = null;
//       }
//     };
//   }, [location, locationUpdateCounter]);

//   // Socket Event Listeners
//   useEffect(() => {
//     console.log("🔌 Setting up socket listeners...");

//     const handleConnect = () => {
//       if (!isMounted.current) return;
//       console.log("✅ Driver socket connected:", socket.id);
//       setSocketConnected(true);

//       if (location && driverId) {
//         console.log("📝 Registering driver with socket after connection...");
//         socket.emit("registerDriver", {
//           driverId,
//           driverName,
//           latitude: location.latitude,
//           longitude: location.longitude,
//           vehicleType: "taxi",
//         });
//         setIsRegistered(true);
//         setDriverStatus("online");
//         console.log("✅ Driver registered after socket connection");
//       }
//     };

//     const handleRideRequest = (data: any) => {
//       if (!isMounted.current) return;

//       console.log("🚨 ===== NEW RIDE REQUEST DEBUG =====");
//       console.log("📦 Raw ride data:", JSON.stringify(data, null, 2));
//       console.log("🚨 ===== END RIDE REQUEST DEBUG =====");

//       if (!data || !data.rideId) {
//         console.error("❌ INVALID RIDE REQUEST - missing rideId:", data);
//         return;
//       }

//       try {
//         const rideData: RideType = {
//           rideId: data.rideId || "",
//           RAID_ID: data.RAID_ID || "N/A",
//           otp: data.otp || "0000",
//           pickup: {
//             latitude: data.pickup?.lat || data.pickup?.latitude || 0,
//             longitude: data.pickup?.lng || data.pickup?.longitude || 0,
//             address: data.pickup?.address || "Unknown location",
//           },
//           drop: {
//             latitude: data.drop?.lat || data.drop?.latitude || 0,
//             longitude: data.drop?.lng || data.drop?.longitude || 0,
//             address: data.drop?.address || "Unknown location",
//           },
//           fare: data.fare || 0,
//           distance: data.distance || "0 km",
//         };

//         console.log("✅ Processed ride data:", rideData);

//         setRide(rideData);
//         setRideStatus("onTheWay");

//         console.log("📊 State updated - ride set, status: onTheWay");

//         setTimeout(() => {
//           if (!isMounted.current) return;

//           Alert.alert(
//             "🚖 New Ride Request!",
//             `📍 Pickup: ${rideData.pickup.address}\n🎯 Drop: ${rideData.drop.address}\n💰 Fare: ₹${rideData.fare}\n📏 Distance: ${rideData.distance}`,
//             [
//               {
//                 text: "❌ Reject",
//                 onPress: () => {
//                   console.log("👎 User rejected ride:", rideData.rideId);
//                   rejectRide(rideData.rideId);
//                 },
//                 style: "destructive",
//               },
//               {
//                 text: "✅ Accept",
//                 onPress: () => {
//                   console.log("👍 User accepted ride:", rideData.rideId);
//                   acceptRide(rideData.rideId);
//                 },
//               },
//             ],
//             {
//               cancelable: false,
//               onDismiss: () => {
//                 console.log("🚫 Alert dismissed, auto-rejecting");
//                 rejectRide(rideData.rideId);
//               },
//             }
//           );
//         }, 500);
//       } catch (error) {
//         console.error("❌ Error processing ride request:", error);
//         Alert.alert("Error", "Could not process ride request. Please try again.");
//       }
//     };

//     const handleUserLiveLocationUpdate = (data: any) => {
//       if (!isMounted.current) return;

//       console.log("📍 User live location update received:", data);

//       if (
//         data &&
//         typeof data.lat === "number" &&
//         typeof data.lng === "number" &&
//         !isNaN(data.lat) &&
//         !isNaN(data.lng)
//       ) {
//         const newUserLocation = {
//           latitude: data.lat,
//           longitude: data.lng,
//         };

//         console.log("📍 Updating user LIVE location to:", newUserLocation);

//         if (data.userId) {
//           userLocationTracking.set(data.userId, newUserLocation);
//           console.log("💾 Stored user location in tracking map for userId:", data.userId);
//         }

//         setUserLocation(prev => {
//           if (
//             prev?.latitude !== newUserLocation.latitude ||
//             prev?.longitude !== newUserLocation.longitude
//           ) {
//             console.log("✅ User location state updated:", newUserLocation);
//             return newUserLocation;
//           }
//           console.log("⏭️ Skipping user location update (no change)");
//           return prev;
//         });

//         setUserData(prev => {
//           if (prev) {
//             const updatedUserData = {
//               ...prev,
//               location: newUserLocation,
//             };
//             console.log("👤 Updated userData with live location:", updatedUserData);
//             return updatedUserData;
//           }
//           return prev;
//         });

//         if (location && (rideStatus === "accepted" || rideStatus === "started")) {
//           console.log("🗺️ Re-routing to user's LIVE location:", newUserLocation);
//           fetchRoute(location, newUserLocation);
//         }
//       } else {
//         console.error("❌ Invalid user location data:", data);
//       }
//     };

//     const handleUserDataForDriver = (data: any) => {
//       if (!isMounted.current) return;

//       console.log("👤 User data received:", data);

//       if (data && data.location) {
//         const userLiveLocation = {
//           latitude: data.location.lat || data.location.latitude,
//           longitude: data.location.lng || data.location.longitude,
//         };

//         console.log("📍 Setting user location from userData:", userLiveLocation);
//         setUserLocation(userLiveLocation);

//         if (userData && !userData.userId && data.userId) {
//           setUserData(prev => prev ? { ...prev, userId: data.userId } : null);
//         }
//       }
//     };

//     const handleRideOTP = (data: any) => {
//       if (!isMounted.current) return;
//       console.log("🔢 Ride OTP received:", data);

//       if (ride && ride.rideId === data.rideId) {
//         setRide((prev) => (prev ? { ...prev, otp: data.otp } : null));
//         console.log(`✅ OTP updated for ride ${data.rideId}: ${data.otp}`);
//       }
//     };

//     const handleDisconnect = (reason: string) => {
//       if (!isMounted.current) return;
//       console.log("❌ Driver socket disconnected, reason:", reason);
//       setSocketConnected(false);
//       setIsRegistered(false);
//       setDriverStatus("offline");
//       if (ride) {
//         setUserData(null);
//         setUserLocation(null);
//         Alert.alert("Connection Lost", "Reconnecting to server...");
//       }
//     };

//     const handleConnectError = (error: Error) => {
//       if (!isMounted.current) return;
//       console.log("❌ Socket connection error:", error.message);
//       setSocketConnected(false);
//       setError("Failed to connect to server");
//     };

//     const handleRideCancelled = (data: any) => {
//       if (!isMounted.current) return;
//       console.log("🚫 Ride cancelled event received:", data);

//       if (ride && ride.rideId === data.rideId) {
//         console.log("✅ Cancelling current ride");
//         setRide(null);
//         setUserData(null);
//         setUserLocation(null);
//         setTravelledKm(0);
//         setLastCoord(null);
//         setRideStatus("idle");
//         setDriverStatus("online");
//         setInitialRegionSet(false);
//         Alert.alert("Ride Cancelled", "The passenger cancelled the ride.");
//       }
//     };

//     const handleRideAlreadyAccepted = (data: any) => {
//       if (!isMounted.current) return;
//       console.log("🚫 Ride already accepted:", data);

//       if (ride && ride.rideId === data.rideId) {
//         console.log("✅ Clearing current ride as it was accepted by another driver");
//         setRide(null);
//         setUserData(null);
//         setUserLocation(null);
//         setTravelledKm(0);
//         setLastCoord(null);
//         setRideStatus("idle");
//         setDriverStatus("online");
//         setInitialRegionSet(false);
//         Alert.alert(
//           "Ride Taken",
//           data.message || "This ride has already been accepted by another driver. Please wait for another ride."
//         );
//       }
//     };

//     socket.on("connect", handleConnect);
//     socket.on("newRideRequest", handleRideRequest);
//     socket.on("userLiveLocationUpdate", handleUserLiveLocationUpdate);
//     socket.on("userDataForDriver", handleUserDataForDriver);
//     socket.on("rideOTP", handleRideOTP);
//     socket.on("disconnect", handleDisconnect);
//     socket.on("connect_error", handleConnectError);
//     socket.on("rideCancelled", handleRideCancelled);
//     socket.on("rideAlreadyAccepted", handleRideAlreadyAccepted);

//     console.log("✅ All socket event listeners attached");

//     if (!socket.connected) {
//       console.log("🔗 Connecting socket...");
//       socket.connect();
//     }

//     return () => {
//       console.log("🧹 Cleaning up socket listeners...");
//       socket.off("connect", handleConnect);
//       socket.off("newRideRequest", handleRideRequest);
//       socket.off("userLiveLocationUpdate", handleUserLiveLocationUpdate);
//       socket.off("userDataForDriver", handleUserDataForDriver);
//       socket.off("rideOTP", handleRideOTP);
//       socket.off("disconnect", handleDisconnect);
//       socket.off("connect_error", handleConnectError);
//       socket.off("rideCancelled", handleRideCancelled);
//       socket.off("rideAlreadyAccepted", handleRideAlreadyAccepted);
//       console.log("✅ Socket event listeners removed");
//     };
//   }, [location, driverId, driverName, ride, rideStatus, userData]);

//   // UI
//   if (error) {
//     console.log("❌ Displaying error UI:", error);
//     return (
//       <View style={styles.errorContainer}>
//         <Text style={styles.errorText}>{error}</Text>
//         <TouchableOpacity
//           style={styles.retryButton}
//           onPress={() => setError(null)}
//         >
//           <Text style={styles.retryText}>Retry</Text>
//         </TouchableOpacity>
//       </View>
//     );
//   }

//   if (!location) {
//     console.log("📍 Waiting for location...");
//     return (
//       <View style={styles.loadingContainer}>
//         <ActivityIndicator size="large" color="#4caf50" />
//         <Text style={styles.loadingText}>Fetching your location...</Text>
//         <TouchableOpacity
//           style={styles.retryButton}
//           onPress={() => {
//             console.log("🔄 Manually retrying location fetch...");
//             Geolocation.getCurrentPosition(
//               (pos) => {
//                 setLocation({
//                   latitude: pos.coords.latitude,
//                   longitude: pos.coords.longitude,
//                 });
//               },
//               (err) => {
//                 console.error("❌ Manual location fetch error:", err);
//                 Alert.alert("Location Error", "Could not get your location. Please check GPS settings.");
//               },
//               { enableHighAccuracy: true, timeout: 15000 }
//             );
//           }}
//         >
//           <Text style={styles.retryText}>Retry Location</Text>
//         </TouchableOpacity>
//       </View>
//     );
//   }

//   console.log("🖥️ Rendering driver UI with status:", {
//     rideStatus,
//     driverStatus,
//     socketConnected,
//     hasRide: !!ride,
//     hasUserLocation: !!userLocation,
//     userLocation,
//     pickupLocation: ride?.pickup,
//   });

//   return (
//     <View style={styles.container}>
//       <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
//       <MapView
//         ref={mapRef}
//         provider={PROVIDER_GOOGLE}
//         style={styles.map}
//         initialRegion={{
//           latitude: location.latitude,
//           longitude: location.longitude,
//           latitudeDelta: 0.01,
//           longitudeDelta: 0.01,
//         }}
//         showsUserLocation
//         showsMyLocationButton={false}
//         followsUserLocation={false}
//         zoomEnabled={true}
//         zoomControlEnabled={true}
//         rotateEnabled={false}
//         scrollEnabled={true}
//         pitchEnabled={false}
//       >
//         {ride && <Marker coordinate={ride.pickup} title="Pickup Location" pinColor="blue" />}
//         {ride && <Marker coordinate={ride.drop} title="Drop Location" pinColor="red" />}
//         {ride?.routeCoords && (
//           <Polyline
//             coordinates={ride.routeCoords}
//             strokeWidth={5}
//             strokeColor="#4caf50"
//           />
//         )}
//         {ride && (rideStatus === "accepted" || rideStatus === "started") && userLocation && (
//           <Marker
//             coordinate={userLocation}
//             title="User Live Location"
//             description={`Current location of ${userData?.name || "User"}`}
//             tracksViewChanges={false} // Disable tracking to improve performance
//             key={`user-location-${userLocation.latitude}-${userLocation.longitude}`} // Force re-render
//           >
//             <View style={styles.blackDotMarker}>
//               <View style={styles.blackDotInner} />
//             </View>
//           </Marker>
//         )}
//       </MapView>

//       <View style={styles.statusContainer}>
//         <View style={styles.statusRow}>
//           <Text style={styles.statusText}>
//             Socket: {socketConnected ? "Connected" : "Disconnected"}
//           </Text>
//           <Text
//             style={[
//               styles.statusText,
//               {
//                 color:
//                   driverStatus === "online"
//                     ? "#4caf50"
//                     : driverStatus === "onRide"
//                     ? "#ff9800"
//                     : "#f44336",
//               },
//             ]}
//           >
//             Status: {driverStatus}
//           </Text>
//         </View>
//         <Text style={styles.locationText}>
//           Driver: {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
//         </Text>
//         {ride && <Text style={styles.rideInfoText}>Ride ID: {ride.rideId}</Text>}
//         {ride && (rideStatus === "accepted" || rideStatus === "started") && userLocation && (
//           <Text style={[styles.rideInfoText, { color: '#4CAF50', fontWeight: 'bold' }]}>
//             User LIVE: {userLocation.latitude.toFixed(6)}, {userLocation.longitude.toFixed(6)}
//           </Text>
//         )}
//         {ride && (rideStatus === "accepted" || rideStatus === "started") && (
//           <Text style={[styles.rideInfoText, { color: '#2196F3' }]}>
//             Pickup: {ride.pickup.latitude.toFixed(6)}, {ride.pickup.longitude.toFixed(6)}
//           </Text>
//         )}
//       </View>

//       {ride && (rideStatus === "accepted" || rideStatus === "started") && userData && (
//         <View style={styles.userDataContainer}>
//           <Text style={styles.userDataTitle}>User Details</Text>
//           <Text style={styles.userDataText}>Name: {userData.name}</Text>
//           <Text style={styles.userDataText}>Mobile: {userData.mobile}</Text>
//           <Text style={styles.userDataText}>Pickup Address: {ride.pickup.address}</Text>
//           <Text style={styles.userDataText}>Drop Address: {ride.drop.address}</Text>
//           {userLocation && (
//             <Text style={[styles.userDataText, { color: '#4CAF50', fontWeight: 'bold' }]}>
//               🟢 LIVE Location Tracking: ACTIVE
//             </Text>
//           )}
//         </View>
//       )}

//       {ride && rideStatus === "onTheWay" && (
//         <View style={styles.rideActions}>
//           <TouchableOpacity
//             style={[styles.button, styles.acceptButton]}
//             onPress={() => acceptRide()}
//           >
//             <Text style={styles.btnText}>Accept Ride</Text>
//           </TouchableOpacity>
//           <TouchableOpacity
//             style={[styles.button, styles.rejectButton]}
//             onPress={() => rejectRide()}
//           >
//             <Text style={styles.btnText}>Reject Ride</Text>
//           </TouchableOpacity>
//         </View>
//       )}

//       {ride && rideStatus === "accepted" && (
//         <TouchableOpacity
//           style={[styles.button, styles.startButton]}
//           onPress={() => setOtpModalVisible(true)}
//         >
//           <Text style={styles.btnText}>Enter OTP & Start Ride</Text>
//         </TouchableOpacity>
//       )}

//       {ride && rideStatus === "started" && (
//         <TouchableOpacity
//           style={[styles.button, styles.completeButton]}
//           onPress={completeRide}
//         >
//           <Text style={styles.btnText}>
//             Complete Ride ({travelledKm.toFixed(2)} km)
//           </Text>
//         </TouchableOpacity>
//       )}

//       <Modal visible={otpModalVisible} transparent animationType="slide">
//         <View style={styles.modalContainer}>
//           <View style={styles.modalContent}>
//             <Text style={styles.modalTitle}>Enter OTP</Text>
//             <TextInput
//               placeholder="Enter 4-digit OTP"
//               value={enteredOtp}
//               onChangeText={setEnteredOtp}
//               keyboardType="numeric"
//               style={styles.input}
//               maxLength={4}
//             />
//             <View style={styles.modalButtons}>
//               <TouchableOpacity
//                 style={[styles.button, styles.cancelButton]}
//                 onPress={() => setOtpModalVisible(false)}
//               >
//                 <Text style={styles.btnText}>Cancel</Text>
//               </TouchableOpacity>
//               <TouchableOpacity
//                 style={[styles.button, styles.confirmButton]}
//                 onPress={confirmOTP}
//               >
//                 <Text style={styles.btnText}>Confirm OTP</Text>
//               </TouchableOpacity>
//             </View>
//           </View>
//         </View>
//       </Modal>
//     </View>
//   );
// };

// export default DriverScreen;

// // Styles
// const styles = StyleSheet.create({
//   container: { 
//     flex: 1,
//     backgroundColor: '#f5f5f5'
//   },
//   map: { 
//     flex: 1 
//   },
//   loadingContainer: {
//     flex: 1,
//     justifyContent: "center",
//     alignItems: "center",
//     backgroundColor: "#f5f5f5",
//   },
//   loadingText: {
//     marginTop: 10,
//     fontSize: 16,
//     color: "#666",
//   },
//   statusContainer: {
//     position: "absolute",
//     top: 50,
//     left: 10,
//     right: 10,
//     backgroundColor: "rgba(255, 255, 255, 0.9)",
//     padding: 10,
//     borderRadius: 8,
//     elevation: 3,
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 2 },
//     shadowOpacity: 0.1,
//     shadowRadius: 4,
//   },
//   statusRow: {
//     flexDirection: "row",
//     justifyContent: "space-between",
//     marginBottom: 5,
//   },
//   statusText: {
//     fontSize: 14,
//     fontWeight: "bold",
//   },
//   locationText: {
//     fontSize: 12,
//     color: "#666",
//     marginTop: 2,
//   },
//   rideInfoText: {
//     fontSize: 10,
//     color: "#888",
//     marginTop: 2,
//   },
//   rideActions: {
//     flexDirection: "row",
//     justifyContent: "space-around",
//     margin: 10,
//     gap: 10,
//   },
//   button: {
//     padding: 15,
//     borderRadius: 8,
//     alignItems: "center",
//     elevation: 2,
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 2 },
//     shadowOpacity: 0.2,
//     shadowRadius: 3,
//     minWidth: 120,
//   },
//   acceptButton: { 
//     backgroundColor: "#4caf50", 
//     flex: 1 
//   },
//   rejectButton: { 
//     backgroundColor: "#f44336", 
//     flex: 1 
//   },
//   startButton: { 
//     backgroundColor: "#2196f3", 
//     margin: 10 
//   },
//   completeButton: { 
//     backgroundColor: "#ff9800", 
//     margin: 10 
//   },
//   cancelButton: { 
//     backgroundColor: "#757575", 
//     flex: 1, 
//     marginRight: 5 
//   },
//   confirmButton: { 
//     backgroundColor: "#4caf50", 
//     flex: 1, 
//     marginLeft: 5 
//   },
//   btnText: {
//     color: "#fff",
//     fontWeight: "bold",
//     fontSize: 14,
//   },
//   modalContainer: {
//     flex: 1,
//     justifyContent: "center",
//     alignItems: "center",
//     backgroundColor: "rgba(0,0,0,0.5)",
//   },
//   modalContent: {
//     backgroundColor: "white",
//     padding: 20,
//     borderRadius: 10,
//     width: "80%",
//     elevation: 5,
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 2 },
//     shadowOpacity: 0.25,
//     shadowRadius: 4,
//   },
//   modalTitle: {
//     fontSize: 20,
//     fontWeight: "bold",
//     marginBottom: 15,
//     textAlign: "center",
//     color: "#333",
//   },
//   input: {
//     borderWidth: 1,
//     borderColor: "#ddd",
//     borderRadius: 5,
//     marginVertical: 10,
//     padding: 12,
//     fontSize: 16,
//     textAlign: "center",
//   },
//   modalButtons: {
//     flexDirection: "row",
//     marginTop: 15,
//     gap: 10,
//   },
//   errorContainer: {
//     flex: 1,
//     justifyContent: "center",
//     alignItems: "center",
//     backgroundColor: "#f5f5f5",
//   },
//   errorText: {
//     fontSize: 16,
//     color: "#f44336",
//     marginBottom: 20,
//     textAlign: "center",
//   },
//   retryButton: {
//     marginTop: 20,
//     backgroundColor: "#4caf50",
//     paddingVertical: 10,
//     paddingHorizontal: 20,
//     borderRadius: 8,
//   },
//   retryText: {
//     color: "#fff",
//     fontWeight: "bold",
//   },
//   blackDotMarker: {
//     backgroundColor: "rgba(0, 0, 0, 0.8)",
//     width: 20,
//     height: 20,
//     borderRadius: 10,
//     justifyContent: "center",
//     alignItems: "center",
//     borderWidth: 2,
//     borderColor: "#FFFFFF",
//     shadowColor: "#000",
//     shadowOffset: { width: 0, height: 2 },
//     shadowOpacity: 0.8,
//     shadowRadius: 3,
//     elevation: 5,
//   },
//   blackDotInner: {
//     backgroundColor: "#000000",
//     width: 12,
//     height: 12,
//     borderRadius: 6,
//   },
//   userDataContainer: {
//     position: "absolute",
//     bottom: 80,
//     left: 10,
//     right: 10,
//     backgroundColor: "#FFFFFF",
//     padding: 15,
//     borderRadius: 10,
//     elevation: 5,
//     shadowColor: '#000',
//     shadowOffset: { width: 0, height: 2 },
//     shadowOpacity: 0.2,
//     shadowRadius: 4,
//   },
//   userDataTitle: {
//     fontSize: 16,
//     fontWeight: "bold",
//     marginBottom: 10,
//   },
//   userDataText: {
//     fontSize: 14,
//     marginBottom: 5,
//   },
// });
