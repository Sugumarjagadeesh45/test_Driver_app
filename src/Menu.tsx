import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

interface Props {
  name: string;
  phoneNumber: string;
  toggleMenu: () => void;
  handleLogout: () => void;
}

export default function Menu({ name, phoneNumber, toggleMenu, handleLogout }: Props) {
  return (
    <View style={styles.menu}>
      <Text style={styles.user}>👤 {name || "Driver"}</Text>
      <Text style={styles.user}>📞 {phoneNumber || "N/A"}</Text>
      <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}><Text style={{ color: "#fff" }}>Logout</Text></TouchableOpacity>
      <TouchableOpacity onPress={toggleMenu} style={styles.closeBtn}><Text>Close</Text></TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { backgroundColor: "#fff", padding: 20, borderRadius: 10, width: 250 },
  user: { fontSize: 16, marginBottom: 10 },
  logoutBtn: { backgroundColor: "red", padding: 10, borderRadius: 5, marginTop: 10 },
  closeBtn: { padding: 10, marginTop: 10, borderRadius: 5, backgroundColor: "#ccc" },
});
