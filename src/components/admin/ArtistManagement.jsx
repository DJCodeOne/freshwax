// components/admin/ArtistManagement.jsx
import React, { useState, useEffect } from 'react';
import { Search, UserCheck, UserX, Eye, Trash2, TrendingUp } from 'lucide-react';
import { collection, getDocs, updateDoc, deleteDoc, doc } from 'firebase/firestore';

export default function ArtistManagement({ auth, db, stats, setStats }) {
  const [artists, setArtists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedArtist, setSelectedArtist] = useState(null);

  useEffect(() => {
    loadArtists();
  }, []);

  const loadArtists = async () => {
    setLoading(true);
    try {
      const artistsSnapshot = await getDocs(collection(db, 'artists'));
      const artistsList = [];
      artistsSnapshot.forEach(doc => {
        artistsList.push({ id: doc.id, ...doc.data() });
      });
      
      // Sort by registration date (newest first)
      artistsList.sort((a, b) => {
        const dateA = a.registeredAt || 0;
        const dateB = b.registeredAt || 0;
        return dateB - dateA;
      });

      setArtists(artistsList);

      // Update stats
      setStats(prev => ({
        ...prev,
        totalArtists: artistsList.length,
        pendingArtists: artistsList.filter(a => !a.hasUploadAccess).length
      }));
    } catch (error) {
      console.error('Error loading artists:', error);
    } finally {
      setLoading(false);
    }
  };

  const approveArtist = async (artistId) => {
    try {
      await updateDoc(doc(db, 'artists', artistId), {
        hasUploadAccess: true,
        approvedAt: new Date().toISOString()
      });
      loadArtists();
    } catch (error) {
      console.error('Error approving artist:', error);
      alert('Failed to approve artist');
    }
  };

  const revokeArtist = async (artistId) => {
    if (!confirm('Revoke upload access for this artist?')) return;
    
    try {
      await updateDoc(doc(db, 'artists', artistId), {
        hasUploadAccess: false,
        revokedAt: new Date().toISOString()
      });
      loadArtists();
    } catch (error) {
      console.error('Error revoking artist:', error);
      alert('Failed to revoke artist');
    }
  };

  const deleteArtist = async (artistId) => {
    if (!confirm('Permanently delete this artist? This cannot be undone.')) return;
    
    try {
      await deleteDoc(doc(db, 'artists', artistId));
      loadArtists();
    } catch (error) {
      console.error('Error deleting artist:', error);
      alert('Failed to delete artist');
    }
  };

  // Filter artists
  const filteredArtists = artists.filter(artist => {
    const matchesSearch = artist.artistName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         artist.email?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterStatus === 'all' ? true :
                         filterStatus === 'pending' ? !artist.hasUploadAccess :
                         filterStatus === 'approved' ? artist.hasUploadAccess : true;
    return matchesSearch && matchesFilter;
  });

  if (loading) {
    return (
      <div className="admin-loading-section">
        <div className="admin-spinner"></div>
        <p>Loading artists...</p>
      </div>
    );
  }

  return (
    <div className="admin-section">
      <div className="admin-header">
        <div>
          <h1 className="admin-title">Artist Management</h1>
          <p className="admin-subtitle">Manage artist accounts and upload permissions</p>
        </div>
        <button onClick={loadArtists} className="admin-refresh-btn">
          <TrendingUp size={18} />
          Refresh
        </button>
      </div>

      <div className="admin-content">
        {/* Toolbar */}
        <div className="admin-toolbar">
          <div className="admin-search-bar">
            <Search size={18} />
            <input 
              type="text"
              placeholder="Search artists by name or email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="admin-filter-tabs">
            <button 
              onClick={() => setFilterStatus('all')}
              className={`admin-filter-tab ${filterStatus === 'all' ? 'active' : ''}`}
            >
              All ({artists.length})
            </button>
            <button 
              onClick={() => setFilterStatus('pending')}
              className={`admin-filter-tab ${filterStatus === 'pending' ? 'active' : ''}`}
            >
              Pending ({stats.pendingArtists})
            </button>
            <button 
              onClick={() => setFilterStatus('approved')}
              className={`admin-filter-tab ${filterStatus === 'approved' ? 'active' : ''}`}
            >
              Approved ({stats.totalArtists - stats.pendingArtists})
            </button>
          </div>
        </div>

        {/* Artists Table */}
        <div className="admin-card">
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Artist Name</th>
                  <th>Email</th>
                  <th>Genre</th>
                  <th>Phone</th>
                  <th>Registered</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredArtists.length === 0 ? (
                  <tr className="admin-empty-row">
                    <td colSpan="7">No artists found</td>
                  </tr>
                ) : (
                  filteredArtists.map(artist => (
                    <tr key={artist.id}>
                      <td className="admin-td-bold">{artist.artistName || 'N/A'}</td>
                      <td>{artist.email}</td>
                      <td>{artist.genre || 'N/A'}</td>
                      <td>{artist.phone || 'N/A'}</td>
                      <td>{artist.registeredAt ? new Date(artist.registeredAt).toLocaleDateString() : 'N/A'}</td>
                      <td>
                        {artist.hasUploadAccess ? (
                          <span className="admin-status-badge approved">Approved</span>
                        ) : (
                          <span className="admin-status-badge pending">Pending</span>
                        )}
                      </td>
                      <td>
                        <div className="admin-action-btns">
                          {artist.hasUploadAccess ? (
                            <button 
                              onClick={() => revokeArtist(artist.id)}
                              className="admin-btn-icon danger"
                              title="Revoke Access"
                            >
                              <UserX size={16} />
                            </button>
                          ) : (
                            <button 
                              onClick={() => approveArtist(artist.id)}
                              className="admin-btn-icon success"
                              title="Approve"
                            >
                              <UserCheck size={16} />
                            </button>
                          )}
                          <button 
                            onClick={() => setSelectedArtist(artist)}
                            className="admin-btn-icon info"
                            title="View Details"
                          >
                            <Eye size={16} />
                          </button>
                          <button 
                            onClick={() => deleteArtist(artist.id)}
                            className="admin-btn-icon danger"
                            title="Delete"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedArtist && (
        <div className="admin-modal-overlay" onClick={() => setSelectedArtist(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h2>Artist Details</h2>
              <button onClick={() => setSelectedArtist(null)} className="admin-modal-close">
                ×
              </button>
            </div>
            <div className="admin-modal-content">
              <div className="admin-detail-grid">
                <div className="admin-detail-item">
                  <label>Artist Name</label>
                  <p>{selectedArtist.artistName || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Email</label>
                  <p>{selectedArtist.email}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Genre</label>
                  <p>{selectedArtist.genre || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Phone</label>
                  <p>{selectedArtist.phone || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Registered At</label>
                  <p>{selectedArtist.registeredAt ? new Date(selectedArtist.registeredAt).toLocaleString() : 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Upload Access</label>
                  <p>{selectedArtist.hasUploadAccess ? '✅ Enabled' : '❌ Disabled'}</p>
                </div>
                {selectedArtist.bio && (
                  <div className="admin-detail-item full-width">
                    <label>Bio</label>
                    <p>{selectedArtist.bio}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}