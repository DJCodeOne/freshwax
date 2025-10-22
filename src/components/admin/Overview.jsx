// components/admin/Overview.jsx
import React, { useEffect, useState } from 'react';
import { Users, ShoppingCart, Package, DollarSign, Music, TrendingUp } from 'lucide-react';
import { collection, getDocs } from 'firebase/firestore';

export default function Overview({ auth, db, stats, setStats }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      // Get artists
      const artistsSnapshot = await getDocs(collection(db, 'artists'));
      const artistsList = [];
      artistsSnapshot.forEach(doc => artistsList.push({ id: doc.id, ...doc.data() }));
      
      // Get customers
      const customersSnapshot = await getDocs(collection(db, 'customers'));
      const customersList = [];
      customersSnapshot.forEach(doc => customersList.push({ id: doc.id, ...doc.data() }));
      
      // Get orders
      const ordersSnapshot = await getDocs(collection(db, 'orders'));
      const ordersList = [];
      let totalRevenue = 0;
      ordersSnapshot.forEach(doc => {
        const data = doc.data();
        ordersList.push({ id: doc.id, ...data });
        totalRevenue += data.amount || 0;
      });
      setOrders(ordersList);
      
      // Get releases
      const releasesSnapshot = await getDocs(collection(db, 'releases'));
      const releasesList = [];
      releasesSnapshot.forEach(doc => releasesList.push({ id: doc.id, ...doc.data() }));

      // Update stats
      setStats({
        totalArtists: artistsList.length,
        pendingArtists: artistsList.filter(a => !a.hasUploadAccess).length,
        totalCustomers: customersList.length,
        totalOrders: ordersList.length,
        totalRevenue: totalRevenue,
        totalReleases: releasesList.length,
        pendingReleases: releasesList.filter(r => r.status === 'pending').length
      });
    } catch (error) {
      console.error('Error loading overview data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="admin-loading-section">
        <div className="admin-spinner"></div>
        <p>Loading overview...</p>
      </div>
    );
  }

  return (
    <div className="admin-section">
      <div className="admin-header">
        <div>
          <h1 className="admin-title">Dashboard Overview</h1>
          <p className="admin-subtitle">Welcome back! Here's what's happening with your store.</p>
        </div>
        <button onClick={loadData} className="admin-refresh-btn">
          <TrendingUp size={18} />
          Refresh Data
        </button>
      </div>

      <div className="admin-content">
        {/* Stats Grid */}
        <div className="admin-stats-grid">
          <div className="admin-stat-card">
            <div className="admin-stat-icon blue">
              <Users size={24} />
            </div>
            <div className="admin-stat-content">
              <p className="admin-stat-label">Total Artists</p>
              <h3 className="admin-stat-value">{stats.totalArtists}</h3>
              <p className="admin-stat-sub">{stats.pendingArtists} pending approval</p>
            </div>
          </div>

          <div className="admin-stat-card">
            <div className="admin-stat-icon green">
              <ShoppingCart size={24} />
            </div>
            <div className="admin-stat-content">
              <p className="admin-stat-label">Total Customers</p>
              <h3 className="admin-stat-value">{stats.totalCustomers}</h3>
            </div>
          </div>

          <div className="admin-stat-card">
            <div className="admin-stat-icon purple">
              <Package size={24} />
            </div>
            <div className="admin-stat-content">
              <p className="admin-stat-label">Total Orders</p>
              <h3 className="admin-stat-value">{stats.totalOrders}</h3>
            </div>
          </div>

          <div className="admin-stat-card">
            <div className="admin-stat-icon orange">
              <DollarSign size={24} />
            </div>
            <div className="admin-stat-content">
              <p className="admin-stat-label">Total Revenue</p>
              <h3 className="admin-stat-value">£{stats.totalRevenue.toFixed(2)}</h3>
            </div>
          </div>

          <div className="admin-stat-card">
            <div className="admin-stat-icon pink">
              <Music size={24} />
            </div>
            <div className="admin-stat-content">
              <p className="admin-stat-label">Total Releases</p>
              <h3 className="admin-stat-value">{stats.totalReleases}</h3>
              <p className="admin-stat-sub">{stats.pendingReleases} pending review</p>
            </div>
          </div>
        </div>

        {/* Recent Orders */}
        <div className="admin-card">
          <h2 className="admin-card-title">Recent Orders</h2>
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Order ID</th>
                  <th>Customer</th>
                  <th>Release</th>
                  <th>Amount</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr className="admin-empty-row">
                    <td colSpan="5">No orders yet</td>
                  </tr>
                ) : (
                  orders.slice(0, 10).map(order => (
                    <tr key={order.id}>
                      <td className="admin-td-mono">{order.id.slice(0, 8)}...</td>
                      <td>{order.customerEmail || 'N/A'}</td>
                      <td>{order.releaseTitle || 'N/A'}</td>
                      <td className="admin-td-bold">£{(order.amount || 0).toFixed(2)}</td>
                      <td>{order.createdAt ? new Date(order.createdAt.seconds * 1000).toLocaleDateString() : 'N/A'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}