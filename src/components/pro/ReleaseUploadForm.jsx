// components/pro/ReleaseUploadForm.jsx
// Comprehensive release upload form with all fields from the uploader
import React, { useState, useEffect, useRef } from 'react';

// Validation utilities
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPrice = (price) => /^\d+(\.\d{1,2})?$/.test(price) && parseFloat(price) >= 0;

const isValidAudioFile = (file) => {
  const validTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav'];
  const validExtensions = ['.mp3', '.wav'];
  const fileName = file.name.toLowerCase();
  const isValid = validTypes.includes(file.type) || validExtensions.some(ext => fileName.endsWith(ext));
  const MAX_FILE_SIZE = 200 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    alert(`File ${file.name} exceeds 200MB limit.`);
    return false;
  }
  return isValid;
};

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

const detectAudioDuration = (file) => {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      resolve(`${minutes}:${seconds.toString().padStart(2, '0')}`);
      URL.revokeObjectURL(audio.src);
    };
    audio.onerror = () => {
      reject(new Error('Could not load audio metadata'));
      URL.revokeObjectURL(audio.src);
    };
    audio.src = URL.createObjectURL(file);
  });
};

const validateArtwork = (file) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const width = img.width;
      const height = img.height;
      if (width < 1200 || height < 1200) {
        const proceed = window.confirm(`Artwork resolution is ${width}x${height}px. Recommended minimum is 1200x1200px. Continue anyway?`);
        if (!proceed) { reject('Artwork resolution too low'); URL.revokeObjectURL(img.src); return; }
      }
      const aspectRatio = width / height;
      if (Math.abs(aspectRatio - 1) > 0.1) {
        const proceed = window.confirm(`Artwork is not square (${width}x${height}). Square artwork (1:1 ratio) is recommended. Continue anyway?`);
        if (!proceed) { reject('Artwork not square'); URL.revokeObjectURL(img.src); return; }
      }
      URL.revokeObjectURL(img.src);
      resolve({ width, height });
    };
    img.onerror = () => { reject('Could not load image'); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(file);
  });
};

const formatDate = (date) => {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
};

export default function ReleaseUploadForm({ userEmail: initialEmail, userId: initialUserId, artistName: defaultArtistName }) {
  // Form state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [currentUploadFile, setCurrentUploadFile] = useState('');
  const [submitError, setSubmitError] = useState(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submissionRef, setSubmissionRef] = useState('');

  // User data (can be updated via event from parent)
  const [userId, setUserId] = useState(initialUserId || '');

  // Artist Info
  const [artistName, setArtistName] = useState(defaultArtistName || '');
  const [email, setEmail] = useState(initialEmail || '');

  // Listen for user data from parent page
  useEffect(() => {
    const handleUserReady = (e) => {
      const { email: userEmail, userId: uid, artistName: name } = e.detail || {};
      if (userEmail && !email) setEmail(userEmail);
      if (uid) setUserId(uid);
      if (name && !artistName) setArtistName(name);
    };

    window.addEventListener('fw:user-ready', handleUserReady);
    return () => window.removeEventListener('fw:user-ready', handleUserReady);
  }, [email, artistName]);

  // Release Details
  const [releaseName, setReleaseName] = useState('');
  const [releaseType, setReleaseType] = useState('EP');
  const [labelCode, setLabelCode] = useState('');
  const [masteredBy, setMasteredBy] = useState('');
  const [genre, setGenre] = useState('Drum and Bass');
  const [customGenre, setCustomGenre] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d;
  });
  const [showCalendar, setShowCalendar] = useState(false);

  // Pre-order
  const [hasPreOrder, setHasPreOrder] = useState(false);
  const [preOrderDate, setPreOrderDate] = useState(null);
  const [showPreOrderCalendar, setShowPreOrderCalendar] = useState(false);

  // Content flags
  const [hasExplicitContent, setHasExplicitContent] = useState(false);

  // Previous release
  const [isPreviouslyReleased, setIsPreviouslyReleased] = useState(false);
  const [recordingLocation, setRecordingLocation] = useState('');
  const [recordingYear, setRecordingYear] = useState('');

  // Copyright & Publishing
  const [copyrightYear, setCopyrightYear] = useState(new Date().getFullYear().toString());
  const [copyrightHolder, setCopyrightHolder] = useState('');
  const [publishingRights, setPublishingRights] = useState('');
  const [publishingCompany, setPublishingCompany] = useState('');
  const [primaryLanguage, setPrimaryLanguage] = useState('English');
  const [showAdvancedMetadata, setShowAdvancedMetadata] = useState(false);

  // Pricing
  const [digitalPrice, setDigitalPrice] = useState('5.00');
  const [trackPrice, setTrackPrice] = useState('1.00');
  const [showTrackPricing, setShowTrackPricing] = useState(false);

  // Vinyl
  const [hasVinylRelease, setHasVinylRelease] = useState(false);
  const [vinylPrice, setVinylPrice] = useState('');
  const [vinylRecordCount, setVinylRecordCount] = useState('');
  const [vinylRPM, setVinylRPM] = useState('33');
  const [vinylSize, setVinylSize] = useState('12"');
  const [vinylWeight, setVinylWeight] = useState('140g');
  const [pressingPlant, setPressingPlant] = useState('');
  const [expectedShippingDate, setExpectedShippingDate] = useState('');
  const [showShippingDateCalendar, setShowShippingDateCalendar] = useState(false);

  // Limited Edition
  const [hasLimitedEdition, setHasLimitedEdition] = useState(false);
  const [limitedEditionType, setLimitedEditionType] = useState('');
  const [limitedEditionDetails, setLimitedEditionDetails] = useState('');

  // Social Links
  const [instagramLink, setInstagramLink] = useState('');
  const [soundcloudLink, setSoundcloudLink] = useState('');
  const [spotifyLink, setSpotifyLink] = useState('');
  const [bandcampLink, setBandcampLink] = useState('');
  const [youtubeLink, setYoutubeLink] = useState('');
  const [otherLinks, setOtherLinks] = useState('');
  const [releaseDescription, setReleaseDescription] = useState('');

  // Barcode
  const [upcEanCode, setUpcEanCode] = useState('');
  const [showCodesInfo, setShowCodesInfo] = useState(false);

  // Artwork
  const [artworkFile, setArtworkFile] = useState(null);
  const [artworkPreview, setArtworkPreview] = useState(null);
  const [artworkDimensions, setArtworkDimensions] = useState(null);

  // Tracks
  const [tracks, setTracks] = useState([{
    id: Date.now().toString(),
    trackNumber: 1,
    trackName: '',
    audioFile: null,
    bpm: 170,
    key: '--',
    duration: '',
    trackISRC: '',
    featured: '',
    remixer: ''
  }]);

  // Cleanup artwork preview URL on unmount
  useEffect(() => {
    return () => {
      if (artworkPreview) URL.revokeObjectURL(artworkPreview);
    };
  }, [artworkPreview]);

  // Track handlers
  const addTrack = () => {
    setTracks([...tracks, {
      id: Date.now().toString(),
      trackNumber: tracks.length + 1,
      trackName: '',
      audioFile: null,
      bpm: 170,
      key: '--',
      duration: '',
      trackISRC: '',
      featured: '',
      remixer: ''
    }]);
  };

  const removeTrack = (id) => {
    if (tracks.length > 1) {
      const filtered = tracks.filter(t => t.id !== id);
      const renumbered = filtered.map((track, index) => ({ ...track, trackNumber: index + 1 }));
      setTracks(renumbered);
    }
  };

  const updateTrack = (id, field, value) => {
    setTracks(tracks.map(track => track.id === id ? { ...track, [field]: value } : track));
  };

  const updateTrackAudioFile = async (id, file) => {
    let duration = '';
    if (file) {
      try {
        duration = await detectAudioDuration(file);
      } catch (e) {
        console.warn('Could not detect duration:', e);
      }
    }
    setTracks(tracks.map(track => track.id === id ? { ...track, audioFile: file, duration } : track));
  };

  const moveTrack = (index, direction) => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= tracks.length) return;
    const newTracks = [...tracks];
    [newTracks[index], newTracks[newIndex]] = [newTracks[newIndex], newTracks[index]];
    setTracks(newTracks.map((track, idx) => ({ ...track, trackNumber: idx + 1 })));
  };

  // Artwork handler
  const handleArtworkUpload = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        const dimensions = await validateArtwork(file);
        setArtworkFile(file);
        setArtworkDimensions(dimensions);
        setArtworkPreview(URL.createObjectURL(file));
      } catch (error) {
        alert(`Artwork validation error: ${error}`);
      }
    }
  };

  const removeArtwork = () => {
    setArtworkFile(null);
    setArtworkDimensions(null);
    if (artworkPreview) URL.revokeObjectURL(artworkPreview);
    setArtworkPreview(null);
  };

  // Get presigned URL for file upload
  const getPresignedUrl = async (key, contentType) => {
    const response = await fetch('/api/releases/presign-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, contentType, bucket: 'uploads' })
    });
    if (!response.ok) throw new Error('Failed to get presigned URL');
    return response.json();
  };

  // Upload file to R2 using presigned URL
  const uploadFile = async (file, key) => {
    const { uploadUrl } = await getPresignedUrl(key, file.type || 'application/octet-stream');
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' }
    });
    if (!response.ok) throw new Error(`Failed to upload ${file.name}`);
    return key;
  };

  // Form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitError(null);
    setUploadProgress(0);

    try {
      // Validation
      if (!artistName.trim()) throw new Error('Artist name is required');
      if (!email.trim() || !isValidEmail(email)) throw new Error('Valid email is required');
      if (!releaseName.trim()) throw new Error('Release name is required');
      if (!artworkFile) throw new Error('Artwork is required');
      if (tracks.some(t => !t.trackName.trim())) throw new Error('All tracks must have names');
      if (tracks.some(t => !t.audioFile)) throw new Error('All tracks must have audio files');

      const timestamp = Date.now();
      const folderName = `submissions/${artistName.replace(/[^a-z0-9]/gi, '_')}_${timestamp}`;

      // Build metadata
      const metadata = {
        artistName: artistName.trim(),
        email: email.trim(),
        userId: userId || null,
        releaseName: releaseName.trim(),
        releaseType,
        labelCode: labelCode.trim(),
        masteredBy: masteredBy.trim(),
        genre: genre === 'Other' ? customGenre.trim() : genre,
        releaseDate: selectedDate.toISOString().split('T')[0],
        hasPreOrder,
        preOrderDate: preOrderDate ? preOrderDate.toISOString().split('T')[0] : null,
        hasExplicitContent,
        isPreviouslyReleased,
        recordingLocation: recordingLocation.trim(),
        recordingYear: recordingYear.trim(),
        copyrightYear,
        copyrightHolder: copyrightHolder.trim(),
        publishingRights,
        publishingCompany: publishingCompany.trim(),
        primaryLanguage,
        pricePerSale: parseFloat(digitalPrice) || 5.00,
        trackPrice: parseFloat(trackPrice) || 1.00,
        vinylRelease: hasVinylRelease,
        vinylPrice: hasVinylRelease ? parseFloat(vinylPrice) || 0 : null,
        vinylRecordCount: hasVinylRelease ? vinylRecordCount : null,
        vinylRPM: hasVinylRelease ? vinylRPM : null,
        vinylSize: hasVinylRelease ? vinylSize : null,
        vinylWeight: hasVinylRelease ? vinylWeight : null,
        pressingPlant: hasVinylRelease ? pressingPlant.trim() : null,
        expectedShippingDate: hasVinylRelease ? expectedShippingDate : null,
        hasLimitedEdition,
        limitedEditionType: hasLimitedEdition ? limitedEditionType : null,
        limitedEditionDetails: hasLimitedEdition ? limitedEditionDetails.trim() : null,
        socialLinks: {
          instagram: instagramLink.trim(),
          soundcloud: soundcloudLink.trim(),
          spotify: spotifyLink.trim(),
          bandcamp: bandcampLink.trim(),
          youtube: youtubeLink.trim(),
          other: otherLinks.trim()
        },
        releaseDescription: releaseDescription.trim(),
        upcEanCode: upcEanCode.trim(),
        tracks: tracks.map(t => ({
          trackNumber: t.trackNumber,
          title: t.trackName.trim(),
          trackName: t.trackName.trim(),
          bpm: t.bpm || null,
          key: t.key || '--',
          duration: t.duration || null,
          trackISRC: t.trackISRC?.trim() || null,
          featured: t.featured?.trim() || null,
          remixer: t.remixer?.trim() || null
        })),
        submittedAt: new Date().toISOString()
      };

      const totalFiles = tracks.length + 2; // tracks + artwork + metadata
      let uploadedFiles = 0;

      // Upload metadata
      setCurrentUploadFile('metadata.json');
      const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
      await uploadFile(new File([metadataBlob], 'metadata.json', { type: 'application/json' }), `${folderName}/metadata.json`);
      uploadedFiles++;
      setUploadProgress(Math.round((uploadedFiles / totalFiles) * 100));

      // Upload artwork
      setCurrentUploadFile(artworkFile.name);
      const artworkExt = artworkFile.name.split('.').pop().toLowerCase();
      await uploadFile(artworkFile, `${folderName}/cover.${artworkExt}`);
      uploadedFiles++;
      setUploadProgress(Math.round((uploadedFiles / totalFiles) * 100));

      // Upload tracks
      for (const track of tracks) {
        if (track.audioFile) {
          setCurrentUploadFile(track.audioFile.name);
          const trackExt = track.audioFile.name.split('.').pop().toLowerCase();
          const trackFileName = `${track.trackNumber.toString().padStart(2, '0')}_${track.trackName.replace(/[^a-z0-9]/gi, '_')}.${trackExt}`;
          await uploadFile(track.audioFile, `${folderName}/tracks/${trackFileName}`);
          uploadedFiles++;
          setUploadProgress(Math.round((uploadedFiles / totalFiles) * 100));
        }
      }

      const ref = `FW-${timestamp.toString().slice(-8)}`;
      setSubmissionRef(ref);
      setSubmitSuccess(true);

    } catch (error) {
      console.error('Upload error:', error);
      setSubmitError(error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Success screen
  if (submitSuccess) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <div className="bg-green-50 border-2 border-green-500 rounded-xl p-8">
          <svg className="w-16 h-16 text-green-500 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Release Submitted!</h2>
          <p className="text-gray-600 mb-4">Your release has been uploaded and is being processed.</p>
          <p className="text-lg font-semibold text-gray-900 mb-6">Reference: {submissionRef}</p>
          <p className="text-sm text-gray-500 mb-6">You'll receive an email at {email} when your release is ready for review.</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-red-600 text-white rounded-lg font-semibold hover:bg-red-700 transition-colors"
          >
            Submit Another Release
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-4xl mx-auto">
      {submitError && (
        <div className="mb-6 p-4 bg-red-50 border-2 border-red-500 rounded-lg">
          <p className="text-red-700 font-medium">{submitError}</p>
        </div>
      )}

      {/* Progress overlay */}
      {isSubmitting && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-8 max-w-md w-full mx-4 text-center">
            <div className="mb-4">
              <div className="w-16 h-16 border-4 border-red-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Uploading Release...</h3>
            <p className="text-gray-600 mb-4">{currentUploadFile}</p>
            <div className="w-full bg-gray-200 rounded-full h-3 mb-2">
              <div className="bg-red-600 h-3 rounded-full transition-all" style={{ width: `${uploadProgress}%` }}></div>
            </div>
            <p className="text-sm text-gray-500">{uploadProgress}% complete</p>
          </div>
        </div>
      )}

      {/* SECTION: Artist Information */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Artist Information</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Artist Name *</label>
            <input
              type="text"
              value={artistName}
              onChange={(e) => setArtistName(e.target.value)}
              required
              className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
              placeholder="Enter artist name"
            />
          </div>
          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Email Address *</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={`w-full px-4 py-3 bg-white border rounded-lg text-gray-900 focus:outline-none focus:ring-2 ${
                email && !isValidEmail(email) ? 'border-red-300 focus:ring-red-500' : 'border-gray-300 focus:ring-red-600'
              }`}
              placeholder="your@email.com"
            />
          </div>
        </div>
      </section>

      {/* SECTION: Release Details */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Release Details</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Release Title *</label>
            <input
              type="text"
              value={releaseName}
              onChange={(e) => setReleaseName(e.target.value)}
              required
              className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              placeholder="Enter release title"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Release Type *</label>
              <select
                value={releaseType}
                onChange={(e) => setReleaseType(e.target.value)}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              >
                <option value="Single">Single (1-2 tracks)</option>
                <option value="EP">EP (3-6 tracks)</option>
                <option value="Album">Album (7+ tracks)</option>
                <option value="Compilation">Compilation</option>
                <option value="Remix Package">Remix Package</option>
              </select>
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Genre *</label>
              <select
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              >
                <option value="Drum and Bass">Drum and Bass</option>
                <option value="Jungle">Jungle</option>
                <option value="Other">Other (specify below)</option>
              </select>
            </div>
          </div>

          {genre === 'Other' && (
            <input
              type="text"
              value={customGenre}
              onChange={(e) => setCustomGenre(e.target.value)}
              placeholder="Enter genre"
              required
              className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Label Code (Optional)</label>
              <input
                type="text"
                value={labelCode}
                onChange={(e) => setLabelCode(e.target.value)}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                placeholder="e.g., FW-001"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Mastered by (Optional)</label>
              <input
                type="text"
                value={masteredBy}
                onChange={(e) => setMasteredBy(e.target.value)}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                placeholder="Mastering engineer"
              />
            </div>
          </div>

          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Release Date *</label>
            <input
              type="date"
              value={selectedDate.toISOString().split('T')[0]}
              onChange={(e) => setSelectedDate(new Date(e.target.value))}
              className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
            />
          </div>

          {/* Explicit Content */}
          <div className="bg-gray-100 border-2 border-gray-300 rounded-lg p-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={hasExplicitContent}
                onChange={(e) => setHasExplicitContent(e.target.checked)}
                className="w-5 h-5"
              />
              <span className="text-sm font-semibold text-gray-900">This release contains explicit content</span>
            </label>
          </div>

          {/* Pre-order */}
          <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-4">
            <label className="flex items-center gap-3 cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={hasPreOrder}
                onChange={(e) => setHasPreOrder(e.target.checked)}
                className="w-5 h-5"
              />
              <span className="text-sm font-bold text-gray-900 uppercase tracking-wide">Enable Pre-Order</span>
            </label>
            {hasPreOrder && (
              <div className="mt-3">
                <label className="block text-gray-700 text-sm font-medium mb-2">Pre-Order Start Date</label>
                <input
                  type="date"
                  value={preOrderDate ? preOrderDate.toISOString().split('T')[0] : ''}
                  onChange={(e) => setPreOrderDate(e.target.value ? new Date(e.target.value) : null)}
                  max={selectedDate.toISOString().split('T')[0]}
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                />
                <p className="text-xs text-gray-500 mt-2">Pre-order date must be before the release date</p>
              </div>
            )}
          </div>

          {/* Previously Released */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={isPreviouslyReleased}
                onChange={(e) => setIsPreviouslyReleased(e.target.checked)}
                className="w-5 h-5"
              />
              <span className="text-sm font-semibold text-gray-700">Previously Released / Remaster / Reissue</span>
            </label>
          </div>

          {/* Recording Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Recording Location (Optional)</label>
              <input
                type="text"
                value={recordingLocation}
                onChange={(e) => setRecordingLocation(e.target.value)}
                placeholder="Studio name or city"
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Recording Year (Optional)</label>
              <input
                type="text"
                value={recordingYear}
                onChange={(e) => setRecordingYear(e.target.value)}
                placeholder="2024"
                maxLength={4}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>
        </div>
      </section>

      {/* SECTION: Artwork */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Artwork</h2>
        <div>
          <label className="block text-gray-700 text-sm font-medium mb-2">Release Artwork *</label>
          <input
            type="file"
            accept="image/*"
            onChange={handleArtworkUpload}
            className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-600 hover:file:bg-red-100"
          />
          <p className="mt-2 text-xs text-gray-500">Recommended: 1200x1200px minimum, square (1:1 ratio), JPG or PNG</p>

          {artworkFile && (
            <div className="mt-4 p-4 bg-gray-50 border-2 border-gray-200 rounded-lg">
              <div className="flex items-start gap-4">
                {artworkPreview && (
                  <img src={artworkPreview} alt="Preview" className="w-32 h-32 object-cover rounded-lg border-2 border-gray-300" />
                )}
                <div className="flex-1">
                  <p className="font-semibold text-gray-900">{artworkFile.name}</p>
                  <p className="text-sm text-gray-600">
                    {formatFileSize(artworkFile.size)}
                    {artworkDimensions && ` • ${artworkDimensions.width}x${artworkDimensions.height}px`}
                  </p>
                  <button
                    type="button"
                    onClick={removeArtwork}
                    className="mt-2 px-3 py-1 text-sm text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-100"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* SECTION: Track Listing */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Track Listing</h2>
        <div className="space-y-4">
          {tracks.map((track, index) => (
            <div key={track.id} className="bg-gray-50 border-2 border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-bold text-gray-700">TRACK {track.trackNumber}</span>
                <div className="flex items-center gap-2">
                  {tracks.length > 1 && (
                    <>
                      <button type="button" onClick={() => moveTrack(index, 'up')} disabled={index === 0} className={`p-2 rounded ${index === 0 ? 'text-gray-300' : 'text-gray-600 hover:bg-gray-200'}`}>
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clipRule="evenodd"/></svg>
                      </button>
                      <button type="button" onClick={() => moveTrack(index, 'down')} disabled={index === tracks.length - 1} className={`p-2 rounded ${index === tracks.length - 1 ? 'text-gray-300' : 'text-gray-600 hover:bg-gray-200'}`}>
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                      </button>
                      <button type="button" onClick={() => removeTrack(track.id)} className="p-2 text-red-600 hover:bg-red-50 rounded">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-gray-700 text-sm font-medium mb-2">Track Name *</label>
                  <input
                    type="text"
                    value={track.trackName}
                    onChange={(e) => updateTrack(track.id, 'trackName', e.target.value)}
                    required
                    className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    placeholder="Enter track name"
                  />
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">BPM</label>
                    <select
                      value={track.bpm || 170}
                      onChange={(e) => updateTrack(track.id, 'bpm', parseInt(e.target.value))}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      {Array.from({ length: 201 }, (_, i) => i + 50).map(bpm => (
                        <option key={bpm} value={bpm}>{bpm}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">Key</label>
                    <select
                      value={track.key || '--'}
                      onChange={(e) => updateTrack(track.id, 'key', e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      <option value="--">--</option>
                      {['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'].flatMap(note => [
                        <option key={`${note} min`} value={`${note} min`}>{note} min</option>,
                        <option key={`${note} maj`} value={`${note} maj`}>{note} maj</option>
                      ])}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">Duration</label>
                    <input
                      type="text"
                      value={track.duration || ''}
                      placeholder="Auto"
                      disabled
                      className="w-full px-3 py-2 bg-gray-100 border border-gray-300 rounded text-sm text-gray-600"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">Track ISRC (Optional)</label>
                    <input
                      type="text"
                      value={track.trackISRC || ''}
                      onChange={(e) => updateTrack(track.id, 'trackISRC', e.target.value.toUpperCase())}
                      placeholder="CC-XXX-YY-NNNNN"
                      maxLength={15}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">Featured Artists (Optional)</label>
                    <input
                      type="text"
                      value={track.featured || ''}
                      onChange={(e) => updateTrack(track.id, 'featured', e.target.value)}
                      placeholder="feat. Artist"
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1 uppercase">Remixer (Optional)</label>
                    <input
                      type="text"
                      value={track.remixer || ''}
                      onChange={(e) => updateTrack(track.id, 'remixer', e.target.value)}
                      placeholder="Remixer Name"
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-gray-700 text-sm font-medium mb-2">Audio File (MP3 or WAV) *</label>
                  <input
                    type="file"
                    accept=".mp3,.wav,audio/mpeg,audio/wav"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file && isValidAudioFile(file)) {
                        updateTrackAudioFile(track.id, file);
                      } else if (file) {
                        alert('Invalid file format. Please use MP3 or WAV.');
                        e.target.value = '';
                      }
                    }}
                    className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-600"
                  />
                  {track.audioFile && (
                    <div className="mt-2 p-2 bg-green-50 border border-green-300 rounded flex items-center justify-between">
                      <span className="text-sm text-green-700">{track.audioFile.name} ({formatFileSize(track.audioFile.size)}) {track.duration && `• ${track.duration}`}</span>
                      <button type="button" onClick={() => updateTrack(track.id, 'audioFile', null)} className="text-red-600 hover:text-red-800">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={addTrack}
            className="w-full px-4 py-3 bg-gray-100 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 font-medium hover:bg-gray-200 hover:border-gray-400 flex items-center justify-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Another Track
          </button>
        </div>
      </section>

      {/* SECTION: Copyright & Publishing */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-gray-900 uppercase tracking-wider">Copyright & Publishing</h2>
          <button
            type="button"
            onClick={() => setShowAdvancedMetadata(!showAdvancedMetadata)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 ${showAdvancedMetadata ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700'}`}
          >
            <svg className={`w-4 h-4 transition-transform ${showAdvancedMetadata ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {showAdvancedMetadata ? 'Hide' : 'Show'} Advanced Options
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Copyright Year *</label>
              <input
                type="text"
                value={copyrightYear}
                onChange={(e) => setCopyrightYear(e.target.value)}
                required
                placeholder="2024"
                maxLength={4}
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Copyright Holder *</label>
              <input
                type="text"
                value={copyrightHolder}
                onChange={(e) => setCopyrightHolder(e.target.value)}
                required
                placeholder="Record Label or Artist Name"
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>

          {showAdvancedMetadata && (
            <div className="p-4 bg-gray-50 border-2 border-gray-200 rounded-lg space-y-4">
              <div>
                <label className="block text-gray-700 text-sm font-medium mb-2">Primary Language</label>
                <select
                  value={primaryLanguage}
                  onChange={(e) => setPrimaryLanguage(e.target.value)}
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                >
                  <option value="English">English</option>
                  <option value="Instrumental">Instrumental (No Vocals)</option>
                  <option value="Spanish">Spanish</option>
                  <option value="French">French</option>
                  <option value="German">German</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-gray-700 text-sm font-medium mb-2">Publishing Rights Organization (PRO)</label>
                <select
                  value={publishingRights}
                  onChange={(e) => setPublishingRights(e.target.value)}
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                >
                  <option value="">-- Select PRO --</option>
                  <option value="PRS for Music (UK)">PRS for Music (UK)</option>
                  <option value="ASCAP (US)">ASCAP (US)</option>
                  <option value="BMI (US)">BMI (US)</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-gray-700 text-sm font-medium mb-2">Publishing Company (Optional)</label>
                <input
                  type="text"
                  value={publishingCompany}
                  onChange={(e) => setPublishingCompany(e.target.value)}
                  placeholder="e.g., Your Publishing Ltd."
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                />
              </div>
            </div>
          )}
        </div>
      </section>

      {/* SECTION: Pricing */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Pricing</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Digital Album Price (GBP) *</label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">£</span>
              <input
                type="text"
                value={digitalPrice}
                onChange={(e) => setDigitalPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                required
                placeholder="5.00"
                className="w-full pl-8 pr-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <label className="block text-gray-700 text-sm font-medium mb-2">Individual Track Price</label>
            <button
              type="button"
              onClick={() => setShowTrackPricing(!showTrackPricing)}
              className="text-sm font-medium text-red-600 hover:text-red-700"
            >
              {showTrackPricing ? 'Hide' : 'Customise'} track pricing
            </button>
            {showTrackPricing && (
              <div className="mt-3">
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                  <input
                    type="text"
                    value={trackPrice}
                    onChange={(e) => setTrackPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="1.00"
                    className="w-full pl-8 pr-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Vinyl */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <label className="flex items-center gap-3 cursor-pointer mb-3">
              <input
                type="checkbox"
                checked={hasVinylRelease}
                onChange={(e) => setHasVinylRelease(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-gray-700 text-sm font-medium">This release will have a vinyl version</span>
            </label>

            {hasVinylRelease && (
              <div className="mt-4 space-y-4 pt-4 border-t border-gray-200">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Number of Records *</label>
                    <select
                      value={vinylRecordCount}
                      onChange={(e) => setVinylRecordCount(e.target.value)}
                      required={hasVinylRelease}
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      <option value="">Select</option>
                      <option value="1">1 Record</option>
                      <option value="2">2 Records (Double LP)</option>
                      <option value="3">3 Records</option>
                      <option value="4">4 Records</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Vinyl Price (GBP) *</label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                      <input
                        type="text"
                        value={vinylPrice}
                        onChange={(e) => setVinylPrice(e.target.value.replace(/[^0-9.]/g, ''))}
                        required={hasVinylRelease}
                        placeholder="20.00"
                        className="w-full pl-8 pr-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">RPM</label>
                    <select
                      value={vinylRPM}
                      onChange={(e) => setVinylRPM(e.target.value)}
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      <option value="33">33 RPM</option>
                      <option value="45">45 RPM</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Size</label>
                    <select
                      value={vinylSize}
                      onChange={(e) => setVinylSize(e.target.value)}
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      <option value='7"'>7"</option>
                      <option value='10"'>10"</option>
                      <option value='12"'>12"</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Weight</label>
                    <select
                      value={vinylWeight}
                      onChange={(e) => setVinylWeight(e.target.value)}
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    >
                      <option value="120g">120g</option>
                      <option value="140g">140g</option>
                      <option value="180g">180g</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Pressing Plant (Optional)</label>
                    <input
                      type="text"
                      value={pressingPlant}
                      onChange={(e) => setPressingPlant(e.target.value)}
                      placeholder="e.g., Fresh Press Ltd"
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-700 text-sm font-medium mb-2">Expected Shipping Date</label>
                    <input
                      type="date"
                      value={expectedShippingDate}
                      onChange={(e) => setExpectedShippingDate(e.target.value)}
                      className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                    />
                  </div>
                </div>

                {/* Limited Edition */}
                <div className="pt-3 border-t border-gray-200">
                  <label className="flex items-center gap-3 cursor-pointer mb-3">
                    <input
                      type="checkbox"
                      checked={hasLimitedEdition}
                      onChange={(e) => setHasLimitedEdition(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-gray-700 text-sm font-medium">Limited Edition / Special Variant</span>
                  </label>

                  {hasLimitedEdition && (
                    <div className="space-y-3">
                      <select
                        value={limitedEditionType}
                        onChange={(e) => setLimitedEditionType(e.target.value)}
                        className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
                      >
                        <option value="">Select type</option>
                        <option value="Coloured Vinyl">Coloured Vinyl</option>
                        <option value="Picture Disc">Picture Disc</option>
                        <option value="Numbered Edition">Numbered Edition</option>
                        <option value="Signed Edition">Signed Edition</option>
                        <option value="Other">Other</option>
                      </select>
                      <textarea
                        value={limitedEditionDetails}
                        onChange={(e) => setLimitedEditionDetails(e.target.value)}
                        rows={2}
                        placeholder="e.g., Transparent red vinyl, limited to 300 copies"
                        className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* SECTION: Social Links */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Social Links (Optional)</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Instagram</label>
              <input
                type="url"
                value={instagramLink}
                onChange={(e) => setInstagramLink(e.target.value)}
                placeholder="https://instagram.com/..."
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">SoundCloud</label>
              <input
                type="url"
                value={soundcloudLink}
                onChange={(e) => setSoundcloudLink(e.target.value)}
                placeholder="https://soundcloud.com/..."
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Spotify</label>
              <input
                type="url"
                value={spotifyLink}
                onChange={(e) => setSpotifyLink(e.target.value)}
                placeholder="https://open.spotify.com/..."
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Bandcamp</label>
              <input
                type="url"
                value={bandcampLink}
                onChange={(e) => setBandcampLink(e.target.value)}
                placeholder="https://yourname.bandcamp.com"
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">YouTube</label>
              <input
                type="url"
                value={youtubeLink}
                onChange={(e) => setYoutubeLink(e.target.value)}
                placeholder="https://youtube.com/@..."
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
            <div>
              <label className="block text-gray-700 text-sm font-medium mb-2">Other Links</label>
              <input
                type="text"
                value={otherLinks}
                onChange={(e) => setOtherLinks(e.target.value)}
                placeholder="Beatport, website, etc."
                className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600"
              />
            </div>
          </div>

          <div>
            <label className="block text-gray-700 text-sm font-medium mb-2">Release Description / Message</label>
            <textarea
              value={releaseDescription}
              onChange={(e) => setReleaseDescription(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder="Tell us about your release... Add shout outs, describe the sound, share the story behind the tracks."
              className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:ring-2 focus:ring-red-600 resize-none"
            />
          </div>
        </div>
      </section>

      {/* SECTION: Barcode */}
      <section className="mb-8 pb-8 border-b-2 border-gray-200">
        <h2 className="text-lg font-bold text-gray-900 mb-4 uppercase tracking-wider">Release Barcode (Optional)</h2>
        <div>
          <label className="block text-gray-700 text-sm font-medium mb-2">UPC/EAN Code</label>
          <input
            type="text"
            value={upcEanCode}
            onChange={(e) => setUpcEanCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456789012"
            maxLength={13}
            className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-red-600"
          />
          <p className="mt-2 text-xs text-gray-500">Universal Product Code (12-13 digits) - Identifies your entire album or EP</p>
        </div>
      </section>

      {/* Submit Button */}
      <div className="sticky bottom-0 bg-white py-4 border-t border-gray-200 -mx-4 px-4">
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full px-8 py-4 bg-red-600 text-white rounded-lg font-bold text-lg hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors shadow-lg"
        >
          {isSubmitting ? 'Uploading...' : 'Submit Release'}
        </button>
      </div>
    </form>
  );
}
