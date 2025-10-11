import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

interface NotificationsProps {
  toggleNotifications: () => void;
}

const Notifications: React.FC<NotificationsProps> = ({ toggleNotifications }) => {
  return (
    <View style={styles.notifications}>
      <Text style={styles.header}>Notifications</Text>

      <Text>- Ride accepted by driver</Text>
      <Text>- Payment successful</Text>

      <TouchableOpacity
        style={styles.closeButton}
        onPress={toggleNotifications}
      >
        <Text style={{ color: "#fff" }}>Close</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  notifications: {
    backgroundColor: "#fff",
    padding: 15,
    borderRadius: 8,
    elevation: 5,
    width: 250,
  },
  header: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 10,
  },
  closeButton: {
    backgroundColor: "black",
    padding: 8,
    marginTop: 15,
    borderRadius: 5,
    alignSelf: "flex-end",
  },
});

export default Notifications;
