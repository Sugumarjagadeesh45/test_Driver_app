// src/RejectRideScreen.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  TextInput,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import axios from 'axios';
import { API_BASE } from './apiConfig';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface RejectRideScreenProps {
  route: any;
  navigation: any;
}

const RejectRideScreen: React.FC<RejectRideScreenProps> = ({ route, navigation }) => {
  const { rideId } = route.params;
  const [selectedReason, setSelectedReason] = useState<string>('');
  const [customReason, setCustomReason] = useState<string>('');
  const [token, setToken] = useState<string | null>(null);

  const rejectionReasons = [
    'Distance is too long',
    'Vehicle condition issues',
    'Personal emergency',
    'Traffic conditions are too bad',
    'Feeling unwell',
  ];

  useState(() => {
    const loadToken = async () => {
      const savedToken = await AsyncStorage.getItem('authToken');
      setToken(savedToken);
    };
    loadToken();
  });

// D:\eazyGo\driverapp-main\driverapp-main\src\RejectRideScreen.tsx

const handleRejectRide = async () => {
  if (!token) {
    Alert.alert('Error', 'Authentication token not found');
    return;
  }
  if (!selectedReason && !customReason.trim()) {
    Alert.alert('Error', 'Please select or enter a reason for rejection');
    return;
  }
  try {
    const reason = customReason.trim() || selectedReason;
    
    await axios.put(
      `${API_BASE}/drivers/rides/${rideId}`,
      { 
        status: 'Rejected',
        rejectionReason: reason
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    
    Alert.alert('Ride Rejected', 'The ride has been rejected');
    navigation.navigate('Screen1');
  } catch (error) {
    console.error('Error rejecting ride:', error);
    Alert.alert('Error', 'Failed to reject ride');
  }
};

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <MaterialIcons name="arrow-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Reject Ride</Text>
        <View style={{ width: 28 }} />
      </View>
      
      <ScrollView style={styles.content}>
        <Text style={styles.title}>Why are you rejecting this ride?</Text>
        
        {/* Predefined reasons */}
        <View style={styles.reasonsContainer}>
          {rejectionReasons.map((reason, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.reasonButton,
                selectedReason === reason && styles.selectedReasonButton
              ]}
              onPress={() => {
                setSelectedReason(reason);
                setCustomReason('');
              }}
            >
              <Text
                style={[
                  styles.reasonText,
                  selectedReason === reason && styles.selectedReasonText
                ]}
              >
                {reason}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        
        {/* Custom reason */}
        <Text style={styles.customReasonTitle}>Other reason:</Text>
        <TextInput
          style={styles.customReasonInput}
          multiline
          numberOfLines={4}
          value={customReason}
          onChangeText={(text) => {
            setCustomReason(text);
            setSelectedReason('');
          }}
          placeholder="Enter your reason for rejecting this ride..."
          textAlignVertical="top"
        />
        
        {/* Submit button */}
        <TouchableOpacity
          style={styles.submitButton}
          onPress={handleRejectRide}
        >
          <Text style={styles.submitButtonText}>Submit</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 15,
    backgroundColor: '#4caf50',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    color: '#333',
  },
  reasonsContainer: {
    marginBottom: 20,
  },
  reasonButton: {
    backgroundColor: '#fff',
    padding: 15,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  selectedReasonButton: {
    backgroundColor: '#4caf50',
    borderColor: '#4caf50',
  },
  reasonText: {
    fontSize: 16,
    color: '#333',
  },
  selectedReasonText: {
    color: '#fff',
  },
  customReasonTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 10,
    color: '#333',
  },
  customReasonInput: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    borderWidth: 1,
    borderColor: '#ddd',
    fontSize: 16,
    minHeight: 100,
    marginBottom: 20,
  },
  submitButton: {
    backgroundColor: '#f44336',
    paddingVertical: 15,
    borderRadius: 8,
    alignItems: 'center',
  },
  submitButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default RejectRideScreen;