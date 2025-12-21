// components/AdminReleasePanel.jsx
import React, { useState, useEffect } from 'react';
import { 
  Upload, Users, ShoppingCart, Music, Settings, Tag, 
  LayoutDashboard, Package, Lock
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

// Import section components
import Overview from './admin/Overview';
import ArtistManagement from './admin/ArtistManagement';
import CustomerManagement from './admin/CustomerManagement';
import OrderManagement from './admin/OrderManagement';
import ReleaseManagement from './admin/ReleaseManagement';
import UploadRelease from './admin/UploadRelease';
import EventsOffers from './admin/EventsOffers';
import SettingsPanel from './admin/Settings';

const firebaseConfig = {
  apiKey: import.meta.env.PUBLIC_FIREBASE_API_KEY || 'AIzaSyBiZGsWdvA9ESm3OsUpZ-VQpwqMjMpBY6g',
  authDomain: import.meta.env.PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.PUBLIC_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export default function AdminReleasePanel() {
  const [activeSection, setActiveSection] = useState('overview');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userData, setUserData] = useState(null);
  const [stats, setStats] = useState({
    totalArtists: 0,
    pendingArtists: 0,
    totalCustomers: 0,
    totalOrders: 0,
    totalRevenue: 0,
    totalReleases: 0,
    pendingReleases: 0
  });

  // Check authentication
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        try {
          const adminDoc = await getDoc(doc(db, 'admins', user.uid));
          
          if (adminDoc.exists()) {
            setIsAdmin(true);
            setUserData(adminDoc.data());
            setIsAuthenticated(true);
          } else {
            setIsAuthenticated(false);
          }
        } catch (error) {
          console.error('Error checking access:', error);
        } finally {
          setIsLoading(false);
        }
      } else {
        setIsAuthenticated(false);
        setIsLoading(false);
        window.location.href = '/admin/login';
      }
    });

    return () => unsubscribe();
  }, []);

  const handleLogout = async () => {
    try {
      await signOut(auth);
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  // Loading screen
  if (isLoading) {
    return (
      <div className="admin-loading">
        <div className="admin-spinner"></div>
        <p>Loading Admin Panel...</p>
      </div>
    );
  }

  // Access denied
  if (!isAuthenticated || !isAdmin) {
    return (
      <div className="admin-loading">
        <div className="admin-access-denied">
          <Lock className="admin-lock-icon" />
          <h1>Access Denied</h1>
          <p>You do not have admin permissions</p>
          <button onClick={() => window.location.href = '/'} className="admin-btn-primary">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  // Render active section
  const renderSection = () => {
    const sectionProps = { auth, db, stats, setStats };
    
    switch (activeSection) {
      case 'overview':
        return <Overview {...sectionProps} />;
      case 'artists':
        return <ArtistManagement {...sectionProps} />;
      case 'customers':
        return <CustomerManagement {...sectionProps} />;
      case 'orders':
        return <OrderManagement {...sectionProps} />;
      case 'releases':
        return <ReleaseManagement {...sectionProps} />;
      case 'upload':
        return <UploadRelease {...sectionProps} />;
      case 'events':
        return <EventsOffers {...sectionProps} />;
      case 'settings':
        return <SettingsPanel {...sectionProps} />;
      default:
        return <Overview {...sectionProps} />;
    }
  };

  return (
    <div className="admin-hub">
      {/* Sidebar */}
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <h2>Fresh Wax Admin</h2>
          <p>{userData?.name || 'Administrator'}</p>
        </div>

        <nav className="admin-nav">
          <button 
            onClick={() => setActiveSection('overview')}
            className={`admin-nav-item ${activeSection === 'overview' ? 'active' : ''}`}
          >
            <LayoutDashboard size={20} />
            <span>Overview</span>
          </button>

          <button 
            onClick={() => setActiveSection('artists')}
            className={`admin-nav-item ${activeSection === 'artists' ? 'active' : ''}`}
          >
            <Users size={20} />
            <span>Artists</span>
            {stats.pendingArtists > 0 && (
              <span className="admin-badge">{stats.pendingArtists}</span>
            )}
          </button>

          <button 
            onClick={() => setActiveSection('customers')}
            className={`admin-nav-item ${activeSection === 'customers' ? 'active' : ''}`}
          >
            <ShoppingCart size={20} />
            <span>Customers</span>
          </button>

          <button 
            onClick={() => setActiveSection('orders')}
            className={`admin-nav-item ${activeSection === 'orders' ? 'active' : ''}`}
          >
            <Package size={20} />
            <span>Orders</span>
          </button>

          <button 
            onClick={() => setActiveSection('releases')}
            className={`admin-nav-item ${activeSection === 'releases' ? 'active' : ''}`}
          >
            <Music size={20} />
            <span>Releases</span>
            {stats.pendingReleases > 0 && (
              <span className="admin-badge">{stats.pendingReleases}</span>
            )}
          </button>

          <button 
            onClick={() => setActiveSection('upload')}
            className={`admin-nav-item ${activeSection === 'upload' ? 'active' : ''}`}
          >
            <Upload size={20} />
            <span>Upload Release</span>
          </button>

          <button 
            onClick={() => setActiveSection('events')}
            className={`admin-nav-item ${activeSection === 'events' ? 'active' : ''}`}
          >
            <Tag size={20} />
            <span>Events & Offers</span>
          </button>

          <button 
            onClick={() => setActiveSection('settings')}
            className={`admin-nav-item ${activeSection === 'settings' ? 'active' : ''}`}
          >
            <Settings size={20} />
            <span>Settings</span>
          </button>
        </nav>

        <button onClick={handleLogout} className="admin-logout-btn">
          Logout
        </button>
      </aside>

      {/* Main Content */}
      <main className="admin-main">
        {renderSection()}
      </main>
    </div>
  );
}