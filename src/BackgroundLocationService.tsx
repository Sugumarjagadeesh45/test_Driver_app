// src/services/BackgroundLocationService.ts
import BackgroundService from 'react-native-background-actions';
import Geolocation from '@react-native-community/geolocation';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../apiConfig';
import { Platform } from 'react-native';

const backgroundLocationTask = async (taskData: any) => {
  try {
    console.log('Background location task started');
    
    // Get the token from AsyncStorage
    const token = await AsyncStorage.getItem('authToken');
    if (!token) {
      console.log('No token found, stopping background task');
      BackgroundService.stop();
      return;
    }
    
    // Get the rideId if available
    const rideId = taskData?.rideId;
    
    // For Android, we need to run a foreground service
    if (Platform.OS === 'android') {
      const notificationConfig = {
        taskName: 'Location Tracking',
        taskTitle: 'Tracking your location',
        taskDesc: 'Your location is being tracked for the active ride',
        taskIcon: {
          name: 'ic_launcher',
          type: 'mipmap',
        },
        color: '#4caf50',
        linking: {
          url: 'yourapp://ride', // Deep link to your app
        },
        parameters: {
          delay: 5000, // Update location every 5 seconds
        },
      };
      
      await BackgroundService.updateNotification({
        taskDesc: `Tracking location for ride: ${rideId || 'unknown'}`,
      });
      
      // Run the location tracking in a loop
      await new Promise(async (resolve) => {
        // For Android, we need to run a foreground service
        const interval = setInterval(async () => {
          try {
            // Get current position
            const position = await new Promise((resolve, reject) => {
              Geolocation.getCurrentPosition(
                resolve,
                reject,
                { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
              );
            });
            
            const { latitude, longitude } = position.coords;
            
            // Send location to backend
            await axios.post(
              `${API_BASE}/drivers/update-location`,
              { latitude, longitude, rideId },
              { headers: { Authorization: `Bearer ${token}` } }
            );
            
            console.log('Background location updated:', { latitude, longitude });
          } catch (error) {
            console.error('Error in background location task:', error);
          }
        }, 5000); // Run every 5 seconds
        
        // Keep the task running for 24 hours max
        setTimeout(() => {
          clearInterval(interval);
          resolve(true);
        }, 24 * 60 * 60 * 1000);
      });
    } else {
      // For iOS, we can use a simpler approach
      const locationInterval = setInterval(async () => {
        try {
          const position = await new Promise((resolve, reject) => {
            Geolocation.getCurrentPosition(
              resolve,
              reject,
              { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
            );
          });
          
          const { latitude, longitude } = position.coords;
          
          // Send location to backend
          await axios.post(
            `${API_BASE}/drivers/update-location`,
            { latitude, longitude, rideId },
            { headers: { Authorization: `Bearer ${token}` } }
          );
          
          console.log('Background location updated:', { latitude, longitude });
        } catch (error) {
          console.error('Error in background location task:', error);
        }
      }, 5000);
      
      // Keep the task running for 24 hours max
      await new Promise(resolve => {
        setTimeout(() => {
          clearInterval(locationInterval);
          resolve(true);
        }, 24 * 60 * 60 * 1000);
      });
    }
  } catch (error) {
    console.error('Error in background location task:', error);
  }
};

export default backgroundLocationTask;