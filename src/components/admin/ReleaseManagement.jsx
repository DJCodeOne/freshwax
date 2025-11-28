// components/admin/ReleaseManagement.jsx
import React, { useState, useEffect } from 'react';
import { Search, CheckCircle, X, Eye, Trash2, TrendingUp, Music } from 'lucide-react';
import { collection, getDocs, updateDoc, deleteDoc, doc } from 'firebase/firestore';

export default function ReleaseManagement({ auth, db, stats, setStats }) {
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [selectedRelease, setSelectedRelease] = useState(null);

  useEffect(() => {
    loadReleases();
  }, []);

  const loadReleases = async () => {
    setLoading(true);
    try {
      const releasesSnapshot = await getDocs(collection(db, 'releases'));
      const releasesList = [];
      releasesSnapshot.forEach(doc => {
        releasesList.push({ id: doc.id, ...doc.data() });
      });
      
      // Sort by created date (newest first)
      releasesList.sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
      });

      setReleases(releasesList);

      // Update stats
      setStats(prev => ({
        ...prev,
        totalReleases: releasesList.length,
        pendingReleases: releasesList.filter(r => r.status === 'pending').length
      }));
    } catch (error) {
      console.error('Error loading releases:', error);
    } finally {
      setLoading(false);
    }
  };

  const approveRelease = async (releaseId) => {
    try {
      await updateDoc(doc(db, 'releases', releaseId), {
        status: 'published',
        publishedAt: new Date().toISOString()
      });
      loadReleases();
    } catch (error) {
      console.error('Error approving release:', error);
      alert('Failed to approve release');
    }
  };

  const rejectRelease = async (releaseId) => {
    const reason = prompt('Reason for rejection (optional):');
    
    try {
      await updateDoc(doc(db, 'releases', releaseId), {
        status: 'rejected',
        rejectedAt: new Date().toISOString(),
        rejectionReason: reason || 'Not specified'
      });
      loadReleases();
    } catch (error) {
      console.error('Error rejecting release:', error);
      alert('Failed to reject release');
    }
  };

  const deleteRelease = async (releaseId) => {
    if (!confirm('Permanently delete this release? This cannot be undone.')) return;
    
    try {
      await deleteDoc(doc(db, 'releases', releaseId));
      loadReleases();
    } catch (error) {
      console.error('Error deleting release:', error);
      alert('Failed to delete release');
    }
  };

  // Filter releases
  const filteredReleases = releases.filter(release => {
    const matchesSearch = release.releaseName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         release.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         release.artistName?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter = filterStatus === 'all' ? true :
                         filterStatus === 'pending' ? release.status === 'pending' :
                         filterStatus === 'published' ? release.status === 'published' :
                         filterStatus === 'rejected' ? release.status === 'rejected' : true;
    return matchesSearch && matchesFilter;
  });

  if (loading) {
    return (
      <div className="admin-loading-section">
        <div className="admin-spinner"></div>
        <p>Loading releases...</p>
      </div>
    );
  }

  return (
    <div className="admin-section">
      <div className="admin-header">
        <div>
          <h1 className="admin-title">Release Management</h1>
          <p className="admin-subtitle">Review and manage artist releases</p>
        </div>
        <button onClick={loadReleases} className="admin-refresh-btn">
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
              placeholder="Search releases by name or artist..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="admin-filter-tabs">
            <button 
              onClick={() => setFilterStatus('all')}
              className={`admin-filter-tab ${filterStatus === 'all' ? 'active' : ''}`}
            >
              All ({releases.length})
            </button>
            <button 
              onClick={() => setFilterStatus('pending')}
              className={`admin-filter-tab ${filterStatus === 'pending' ? 'active' : ''}`}
            >
              Pending ({stats.pendingReleases})
            </button>
            <button 
              onClick={() => setFilterStatus('published')}
              className={`admin-filter-tab ${filterStatus === 'published' ? 'active' : ''}`}
            >
              Published
            </button>
            <button 
              onClick={() => setFilterStatus('rejected')}
              className={`admin-filter-tab ${filterStatus === 'rejected' ? 'active' : ''}`}
            >
              Rejected
            </button>
          </div>
        </div>

        {/* Releases Table */}
        <div className="admin-card">
          <div className="admin-table-container">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Artwork</th>
                  <th>Release Name</th>
                  <th>Artist</th>
                  <th>Tracks</th>
                  <th>Price</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredReleases.length === 0 ? (
                  <tr className="admin-empty-row">
                    <td colSpan="8">No releases found</td>
                  </tr>
                ) : (
                  filteredReleases.map(release => (
                    <tr key={release.id}>
                      <td>
                        {release.artworkUrl ? (
                          <img src={release.artworkUrl} alt="Artwork" className="admin-table-img" />
                        ) : (
                          <div className="admin-table-img-placeholder">
                            <Music size={16} />
                          </div>
                        )}
                      </td>
                      <td className="admin-td-bold">{release.releaseName || release.title || 'N/A'}</td>
                      <td>{release.artistName || 'N/A'}</td>
                      <td>{release.tracks?.length || release.trackListing?.length || 0}</td>
                      <td>£{(release.price || release.digitalPrice || 0).toFixed(2)}</td>
                      <td>{release.createdAt ? new Date(release.createdAt).toLocaleDateString() : 'N/A'}</td>
                      <td>
                        {release.status === 'pending' && (
                          <span className="admin-status-badge pending">Pending</span>
                        )}
                        {release.status === 'published' && (
                          <span className="admin-status-badge approved">Published</span>
                        )}
                        {release.status === 'rejected' && (
                          <span className="admin-status-badge rejected">Rejected</span>
                        )}
                      </td>
                      <td>
                        <div className="admin-action-btns">
                          {release.status === 'pending' && (
                            <>
                              <button 
                                onClick={() => approveRelease(release.id)}
                                className="admin-btn-icon success"
                                title="Approve & Publish"
                              >
                                <CheckCircle size={16} />
                              </button>
                              <button 
                                onClick={() => rejectRelease(release.id)}
                                className="admin-btn-icon danger"
                                title="Reject"
                              >
                                <X size={16} />
                              </button>
                            </>
                          )}
                          <button 
                            onClick={() => setSelectedRelease(release)}
                            className="admin-btn-icon info"
                            title="View Details"
                          >
                            <Eye size={16} />
                          </button>
                          <button 
                            onClick={() => deleteRelease(release.id)}
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
      {selectedRelease && (
        <div className="admin-modal-overlay" onClick={() => setSelectedRelease(null)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-modal-header">
              <h2>Release Details</h2>
              <button onClick={() => setSelectedRelease(null)} className="admin-modal-close">
                ×
              </button>
            </div>
            <div className="admin-modal-content">
              {selectedRelease.artworkUrl && (
                <img src={selectedRelease.artworkUrl} alt="Artwork" className="admin-modal-artwork" />
              )}
              <div className="admin-detail-grid">
                <div className="admin-detail-item">
                  <label>Release Name</label>
                  <p>{selectedRelease.releaseName || selectedRelease.title || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Artist</label>
                  <p>{selectedRelease.artistName || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Label</label>
                  <p>{selectedRelease.labelName || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Genre</label>
                  <p>{selectedRelease.genre || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Release Date</label>
                  <p>{selectedRelease.releaseDate || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Price</label>
                  <p>£{(selectedRelease.price || selectedRelease.digitalPrice || 0).toFixed(2)}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Status</label>
                  <p>{selectedRelease.status || 'N/A'}</p>
                </div>
                <div className="admin-detail-item">
                  <label>Submitted</label>
                  <p>{selectedRelease.createdAt ? new Date(selectedRelease.createdAt).toLocaleString() : 'N/A'}</p>
                </div>
                {selectedRelease.description && (
                  <div className="admin-detail-item full-width">
                    <label>Description</label>
                    <p>{selectedRelease.description}</p>
                  </div>
                )}
                {selectedRelease.tracks && selectedRelease.tracks.length > 0 && (
                  <div className="admin-detail-item full-width">
                    <label>Tracks ({selectedRelease.tracks.length})</label>
                    <ul className="admin-track-list">
                      {selectedRelease.tracks.map((track, idx) => (
                        <li key={idx}>
                         {track.track_number || idx + 1}. {track.title}
{track.preview_url && (
  <audio src={track.preview_url} controls className="admin-track-preview" />
)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {selectedRelease.trackListing && selectedRelease.trackListing.length > 0 && (
                  <div className="admin-detail-item full-width">
                    <label>Track Listing ({selectedRelease.trackListing.length})</label>
                    <ul className="admin-track-list">
                      {selectedRelease.trackListing.map((track, idx) => (
                        <li key={idx}>{idx + 1}. {track}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {selectedRelease.status === 'pending' && (
                <div className="admin-modal-actions">
                  <button 
                    onClick={() => {
                      approveRelease(selectedRelease.id);
                      setSelectedRelease(null);
                    }}
                    className="admin-btn-primary"
                  >
                    <CheckCircle size={18} />
                    Approve & Publish
                  </button>
                  <button 
                    onClick={() => {
                      rejectRelease(selectedRelease.id);
                      setSelectedRelease(null);
                    }}
                    className="admin-btn-danger"
                  >
                    <X size={18} />
                    Reject Release
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
