import React, { useState } from 'react';
import { Upload, FolderOpen, Eye, Check, X, AlertCircle, Cloud, CheckCircle } from 'lucide-react';

export default function AdminReleasePanel() {
  const [stage, setStage] = useState('upload'); // upload, cloud, preview, publish
  const [jsonData, setJsonData] = useState(null);
  const [artwork, setArtwork] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [errors, setErrors] = useState([]);
  const [uploadProgress, setUploadProgress] = useState({});
  const [cloudUrls, setCloudUrls] = useState({
    artwork: null,
    metadata: null,
    tracks: []
  });

  const handleZipUpload = async (e) => {
    const file = e.target.files[0];
    if (!file || !file.name.endsWith('.zip')) {
      setErrors(['Please upload a ZIP file']);
      return;
    }

    setErrors([]);
    
    try {
      // Dynamically import JSZip if not available
      let JSZip = window.JSZip;
      if (!JSZip) {
        // Load JSZip from CDN
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
        JSZip = window.JSZip;
      }
      
      const zip = await JSZip.loadAsync(file);
      
      // Debug: List all files in ZIP
      console.log('Files in ZIP:', Object.keys(zip.files));
      
      // Extract metadata.json
      const metadataFile = zip.file('metadata.json');
      if (!metadataFile) {
        setErrors(['ZIP missing metadata.json']);
        return;
      }
      const metadataText = await metadataFile.async('text');
      const metadata = JSON.parse(metadataText);
      console.log('Parsed metadata:', metadata);
      setJsonData(metadata);

      // Extract artwork
      const artworkFiles = Object.keys(zip.files).filter(name => 
        name.startsWith('artwork/') && name.match(/\.(webp|jpg|jpeg|png)$/i)
      );
      if (artworkFiles.length === 0) {
        setErrors(['ZIP missing artwork']);
        return;
      }
      const artworkBlob = await zip.file(artworkFiles[0]).async('blob');
      setArtwork({
        name: artworkFiles[0].split('/')[1],
        blob: artworkBlob,
        url: URL.createObjectURL(artworkBlob)
      });

      // Extract full tracks
      const fullTrackFiles = Object.keys(zip.files).filter(name => 
        name.startsWith('full-tracks/') && name.match(/\.(wav|mp3)$/i)
      );

      // Extract preview clips
      const previewFiles = Object.keys(zip.files).filter(name => 
        name.startsWith('preview-clips/') && name.endsWith('.mp3')
      );

      // Group full tracks by base name (to handle WAV + MP3 pairs)
      const trackGroups = {};
      fullTrackFiles.forEach(path => {
        const fileName = path.split('/')[1];
        const baseName = fileName.replace(/\.(wav|mp3)$/i, '');
        
        if (!trackGroups[baseName]) {
          trackGroups[baseName] = { wav: null, mp3: null };
        }
        
        if (fileName.toLowerCase().endsWith('.wav')) {
          trackGroups[baseName].wav = path;
        } else if (fileName.toLowerCase().endsWith('.mp3')) {
          trackGroups[baseName].mp3 = path;
        }
      });

      // Match tracks with previews (one track per base name)
      const processedTracks = [];
      let trackNumber = 1;
      
      for (const [baseName, files] of Object.entries(trackGroups)) {
        // Prefer WAV, fallback to MP3
        const fullPath = files.wav || files.mp3;
        const fullName = fullPath.split('/')[1];
        
        // Find matching preview
        const previewPath = previewFiles.find(p => 
          p.toLowerCase().includes(baseName.toLowerCase())
        );

        const fullBlob = await zip.file(fullPath).async('blob');
        const previewBlob = previewPath ? await zip.file(previewPath).async('blob') : null;

        // Get both WAV and MP3 if available
        const wavBlob = files.wav ? await zip.file(files.wav).async('blob') : null;
        const mp3Blob = files.mp3 ? await zip.file(files.mp3).async('blob') : null;

        processedTracks.push({
          id: `track-${Date.now()}-${trackNumber}`,
          track_number: trackNumber,
          title: metadata.trackListing?.[trackNumber - 1] || baseName.replace(/-/g, ' '),
          price: 1.00,
          fullFile: {
            name: fullName,
            blob: fullBlob,
            size: fullBlob.size
          },
          wavFile: wavBlob ? {
            name: files.wav.split('/')[1],
            blob: wavBlob,
            size: wavBlob.size
          } : null,
          mp3File: mp3Blob ? {
            name: files.mp3.split('/')[1],
            blob: mp3Blob,
            size: mp3Blob.size
          } : null,
          previewFile: previewBlob ? {
            name: previewPath.split('/')[1],
            blob: previewBlob,
            size: previewBlob.size,
            url: URL.createObjectURL(previewBlob)
          } : null
        });
        
        trackNumber++;
      }

      setTracks(processedTracks);

      // Validation
      const newErrors = [];
      if (processedTracks.length === 0) newErrors.push('No tracks found in ZIP');
      if (processedTracks.some(t => !t.previewFile)) {
        newErrors.push('Some tracks missing preview clips');
      }
      if (!metadata.releaseName && !metadata.title) newErrors.push('Metadata missing "releaseName" or "title"');
      if (!metadata.artistName && !metadata.artist) newErrors.push('Metadata missing "artistName" or "artist"');

      if (newErrors.length === 0) {
        setStage('cloud');
      }
      setErrors(newErrors);

    } catch (err) {
      setErrors([`Error processing ZIP: ${err.message}`]);
    }
  };

  const uploadToCloudStorage = async () => {
    setStage('uploading');
    setErrors([]);

    try {
      // Upload artwork to Cloudinary
      setUploadProgress({ artwork: 0 });
      const artworkUrl = await uploadArtworkToCloudinary();
      if (!artworkUrl) throw new Error('Artwork upload failed');

      // Upload metadata to Cloudinary
      setUploadProgress({ metadata: 0 });
      const metadataUrl = await uploadMetadataToCloudinary();
      if (!metadataUrl) throw new Error('Metadata upload failed');

      // Upload tracks
      const trackUrls = [];
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        
        // Upload WAV to R2 if available
        let wavUrl = null;
        if (track.wavFile) {
          setUploadProgress({ [`track-${i}-wav`]: 0 });
          wavUrl = await uploadToR2(track.wavFile.blob, track.wavFile.name, i + 1);
          setUploadProgress({ [`track-${i}-wav`]: 100 });
        }
        
        // Upload MP3 to R2 if available
        let mp3Url = null;
        if (track.mp3File) {
          setUploadProgress({ [`track-${i}-mp3`]: 0 });
          mp3Url = await uploadToR2(track.mp3File.blob, track.mp3File.name, i + 1);
          setUploadProgress({ [`track-${i}-mp3`]: 100 });
        }
        
        // Upload preview to Cloudinary
        setUploadProgress({ [`track-${i}-preview`]: 0 });
        const previewUrl = await uploadPreviewToCloudinary(track.previewFile.blob, track.previewFile.name);
        setUploadProgress({ [`track-${i}-preview`]: 100 });

        trackUrls.push({
          track_number: track.track_number,
          title: track.title,
          price: track.price,
          wav_url: wavUrl,
          mp3_url: mp3Url,
          cloudinary_preview_url: previewUrl
        });
      }

      setCloudUrls({
        artwork: artworkUrl,
        metadata: metadataUrl,
        tracks: trackUrls
      });

      setStage('preview');

    } catch (err) {
      setErrors([`Upload failed: ${err.message}`]);
      setStage('cloud');
    }
  };

  const uploadArtworkToCloudinary = async () => {
    const formData = new FormData();
    formData.append('file', artwork.blob);
    formData.append('upload_preset', import.meta.env.PUBLIC_CLOUDINARY_PRESET_IMAGE);
    formData.append('folder', 'music-artwork');

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${import.meta.env.PUBLIC_CLOUDINARY_CLOUD_IMAGE}/image/upload`,
      { method: 'POST', body: formData }
    );

    if (!response.ok) throw new Error('Artwork upload failed');
    const data = await response.json();
    setUploadProgress({ artwork: 100 });
    return data.secure_url;
  };

  const uploadMetadataToCloudinary = async () => {
    const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
    const formData = new FormData();
    formData.append('file', blob);
    formData.append('upload_preset', import.meta.env.PUBLIC_CLOUDINARY_PRESET_IMAGE);
    formData.append('folder', 'music-metadata');
    formData.append('resource_type', 'raw');

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${import.meta.env.PUBLIC_CLOUDINARY_CLOUD_IMAGE}/upload`,
      { method: 'POST', body: formData }
    );

    if (!response.ok) throw new Error('Metadata upload failed');
    const data = await response.json();
    setUploadProgress({ metadata: 100 });
    return data.secure_url;
  };

  const uploadToR2 = async (blob, filename, trackNumber) => {
    const formData = new FormData();
    formData.append('file', blob);
    formData.append('filename', filename);
    formData.append('trackNumber', trackNumber);

    const response = await fetch('/api/upload-r2', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) throw new Error('R2 upload failed');
    const data = await response.json();
    return data.url;
  };

  const uploadPreviewToCloudinary = async (blob, filename) => {
    const formData = new FormData();
    formData.append('file', blob);
    formData.append('upload_preset', import.meta.env.PUBLIC_CLOUDINARY_PRESET_AUDIO);
    formData.append('folder', 'music-previews');
    formData.append('resource_type', 'auto');

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${import.meta.env.PUBLIC_CLOUDINARY_CLOUD_AUDIO}/upload`,
      { method: 'POST', body: formData }
    );

    if (!response.ok) throw new Error('Preview upload failed');
    const data = await response.json();
    return data.secure_url;
  };

  const publishToSite = async () => {
    try {
      const releaseData = {
        id: `release-${Date.now()}`,
        ...jsonData,
        artworkUrl: cloudUrls.artwork,
        metadataUrl: cloudUrls.metadata,
        tracks: cloudUrls.tracks,
        createdAt: new Date().toISOString()
      };

      const response = await fetch('/api/save-release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(releaseData)
      });

      if (!response.ok) throw new Error('Failed to publish release');

      setStage('success');
      setTimeout(() => resetAll(), 3000);

    } catch (err) {
      setErrors([`Publish failed: ${err.message}`]);
    }
  };

  const resetAll = () => {
    setStage('upload');
    setJsonData(null);
    setArtwork(null);
    setTracks([]);
    setErrors([]);
    setUploadProgress({});
    setCloudUrls({ artwork: null, metadata: null, tracks: [] });
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Progress Steps */}
        <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
          <div className="flex items-center justify-between">
            <div className={`flex items-center gap-3 ${stage === 'upload' || stage === 'cloud' || stage === 'uploading' || stage === 'preview' || stage === 'success' ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${stage === 'upload' ? 'bg-blue-500 text-white' : stage === 'cloud' || stage === 'uploading' || stage === 'preview' || stage === 'success' ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>
                {stage === 'cloud' || stage === 'uploading' || stage === 'preview' || stage === 'success' ? <Check className="w-5 h-5" /> : '1'}
              </div>
              <span className="font-semibold">Upload ZIP</span>
            </div>
            <div className="flex-1 h-1 bg-gray-200 mx-4">
              <div className={`h-full ${stage === 'cloud' || stage === 'uploading' || stage === 'preview' || stage === 'success' ? 'bg-blue-500' : 'bg-gray-200'}`} />
            </div>
            <div className={`flex items-center gap-3 ${stage === 'cloud' || stage === 'uploading' || stage === 'preview' || stage === 'success' ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${stage === 'cloud' || stage === 'uploading' ? 'bg-blue-500 text-white' : stage === 'preview' || stage === 'success' ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>
                {stage === 'preview' || stage === 'success' ? <Check className="w-5 h-5" /> : '2'}
              </div>
              <span className="font-semibold">Upload to Cloud</span>
            </div>
            <div className="flex-1 h-1 bg-gray-200 mx-4">
              <div className={`h-full ${stage === 'preview' || stage === 'success' ? 'bg-blue-500' : 'bg-gray-200'}`} />
            </div>
            <div className={`flex items-center gap-3 ${stage === 'preview' || stage === 'success' ? 'text-blue-600' : 'text-gray-400'}`}>
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${stage === 'preview' ? 'bg-blue-500 text-white' : stage === 'success' ? 'bg-green-500 text-white' : 'bg-gray-200'}`}>
                {stage === 'success' ? <Check className="w-5 h-5" /> : '3'}
              </div>
              <span className="font-semibold">Preview & Publish</span>
            </div>
          </div>
        </div>

        {/* Stage 1: Upload ZIP */}
        {stage === 'upload' && (
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Fresh Wax - Upload Release Package</h1>
            <p className="text-gray-600 mb-6">Upload the ZIP file created by the Release Packager</p>

            <label className="w-full flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-blue-500 transition-colors p-12 bg-gray-50 hover:bg-gray-100">
              <Upload className="w-16 h-16 text-gray-400 mb-3" />
              <span className="text-lg font-semibold text-gray-700 mb-1">Select Release Package ZIP</span>
              <span className="text-sm text-gray-500">Choose the ZIP file from Release Packager</span>
              <input 
                type="file" 
                accept=".zip"
                onChange={handleZipUpload} 
                className="hidden" 
              />
            </label>

            {errors.length > 0 && (
              <div className="mt-6 bg-red-50 border-l-4 border-red-400 p-4">
                <div className="flex items-start">
                  <AlertCircle className="w-5 h-5 text-red-400 mr-3 flex-shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-red-900 mb-2">Errors:</h3>
                    <ul className="text-sm text-red-800 space-y-1 list-disc list-inside">
                      {errors.map((error, i) => <li key={i}>{error}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Stage 2: Review & Upload to Cloud */}
        {stage === 'cloud' && jsonData && (
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">Review Package & Upload to Cloud Storage</h1>

            {/* Package Summary */}
            <div className="bg-blue-50 border-l-4 border-blue-400 p-4 mb-6">
              <h3 className="text-lg font-semibold text-blue-900 mb-2">📦 Package Contents</h3>
              <div className="grid grid-cols-2 gap-4 text-sm text-blue-800">
                <div><strong>Release:</strong> {jsonData.releaseName || jsonData.title}</div>
                <div><strong>Artist:</strong> {jsonData.artistName || jsonData.artist}</div>
                <div><strong>Artwork:</strong> {artwork.name}</div>
                <div><strong>Tracks:</strong> {tracks.length} tracks ({tracks.length * 2} files)</div>
              </div>
            </div>

            {/* Files List */}
            <div className="mb-6">
              <h3 className="text-xl font-semibold mb-4">Files to Upload:</h3>
              
              <div className="space-y-2 mb-4">
                <div className="bg-gray-50 p-3 rounded border-l-4 border-purple-500">
                  <div className="flex items-start gap-4">
                    <img src={artwork.url} alt="Artwork Preview" className="w-32 h-32 object-cover rounded shadow-md" />
                    <div className="flex-1">
                      <div className="font-semibold">📸 Artwork → Cloudinary</div>
                      <div className="text-sm text-gray-600">{artwork.name}</div>
                      <div className="text-sm text-gray-600">{(artwork.blob.size / 1024).toFixed(2)} KB</div>
                    </div>
                  </div>
                </div>
                <div className="bg-gray-50 p-3 rounded border-l-4 border-purple-500">
                  <div className="font-semibold">📄 Metadata → Cloudinary</div>
                  <div className="text-sm text-gray-600">metadata.json</div>
                </div>
              </div>

              {tracks.map((track, i) => (
                <div key={track.id} className="mb-3">
                  <div className="font-semibold mb-1">Track {i + 1}: {track.title}</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      {track.wavFile && (
                        <div className="bg-gray-50 p-2 rounded border-l-4 border-blue-500 text-sm">
                          <div className="font-semibold">💿 WAV (Lossless) → R2</div>
                          <div className="text-gray-600">{track.wavFile.name}</div>
                          <div className="text-xs text-gray-500">{(track.wavFile.size / 1024 / 1024).toFixed(2)} MB</div>
                        </div>
                      )}
                      {track.mp3File && (
                        <div className="bg-gray-50 p-2 rounded border-l-4 border-indigo-500 text-sm">
                          <div className="font-semibold">💿 MP3 (320kbps) → R2</div>
                          <div className="text-gray-600">{track.mp3File.name}</div>
                          <div className="text-xs text-gray-500">{(track.mp3File.size / 1024 / 1024).toFixed(2)} MB</div>
                        </div>
                      )}
                    </div>
                    <div className="bg-gray-50 p-2 rounded border-l-4 border-green-500 text-sm">
                      <div className="font-semibold">🎵 Preview (60s, 128kbps) → Cloudinary</div>
                      <div className="text-gray-600">{track.previewFile.name}</div>
                      <div className="text-xs text-gray-500">{(track.previewFile.size / 1024).toFixed(2)} KB</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={uploadToCloudStorage}
              className="w-full px-6 py-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center gap-2 text-lg font-semibold"
            >
              <Cloud className="w-6 h-6" />
              Upload All Files to Cloud Storage
            </button>
          </div>
        )}

        {/* Stage 2.5: Uploading Progress */}
        {stage === 'uploading' && (
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">Uploading to Cloud Storage...</h1>
            <div className="space-y-4">
              {Object.entries(uploadProgress).map(([key, progress]) => (
                <div key={key}>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm font-medium">{key}</span>
                    <span className="text-sm font-medium">{progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-blue-500 h-2 rounded-full transition-all" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stage 3: Preview with Real URLs */}
        {stage === 'preview' && cloudUrls.artwork && (
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-lg p-8">
              <h1 className="text-3xl font-bold text-gray-900 mb-6">Preview Release (Live URLs)</h1>

              {/* Cloud URLs Verification */}
              <div className="bg-green-50 border-l-4 border-green-400 p-4 mb-6">
                <h3 className="text-lg font-semibold text-green-900 mb-3 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5" />
                  All Files Uploaded Successfully
                </h3>
                <div className="space-y-2 text-sm">
                  <div className="font-semibold text-green-800">Cloud URLs:</div>
                  <div className="bg-white p-2 rounded">
                    <div className="font-semibold text-xs text-gray-700">Artwork (Cloudinary):</div>
                    <a href={cloudUrls.artwork} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 break-all hover:underline">{cloudUrls.artwork}</a>
                  </div>
                  <div className="bg-white p-2 rounded">
                    <div className="font-semibold text-xs text-gray-700">Metadata (Cloudinary):</div>
                    <a href={cloudUrls.metadata} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 break-all hover:underline">{cloudUrls.metadata}</a>
                  </div>
                  {cloudUrls.tracks.map((track, i) => (
                    <div key={i} className="bg-white p-2 rounded">
                      <div className="font-semibold text-xs text-gray-700">Track {track.track_number}: {track.title}</div>
                      {track.wav_url && <div className="text-xs text-gray-600">WAV (R2): <a href={track.wav_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{track.wav_url}</a></div>}
                      {track.mp3_url && <div className="text-xs text-gray-600">MP3 (R2): <a href={track.mp3_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{track.mp3_url}</a></div>}
                      <div className="text-xs text-gray-600">Preview: <a href={track.cloudinary_preview_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{track.cloudinary_preview_url}</a></div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Release Plate Preview */}
              <div className="bg-white rounded-lg shadow-md overflow-hidden border-2 border-blue-500">
                <div className="bg-blue-500 text-white px-4 py-2 font-semibold">Live Preview (How it will appear on site)</div>
                <div className="flex p-4">
                  <div className="relative w-64 h-64 flex-shrink-0">
                    <img src={cloudUrls.artwork} alt={jsonData.releaseName || jsonData.title} className="w-full h-full object-cover rounded" />
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent flex gap-2 justify-center">
                      <div className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-semibold">
                        £{jsonData.digitalPrice || jsonData.pricePerSale || '0.00'}
                      </div>
                      {jsonData.vinylRelease && (
                        <div className="bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-semibold">
                          £{jsonData.vinylPrice || '0.00'}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 pl-6">
                    <h3 className="text-2xl font-bold text-gray-900 mb-1">{jsonData.releaseName || jsonData.title}</h3>
                    <p className="text-lg text-gray-600 mb-1">{jsonData.artistName || jsonData.artist}</p>
                    {jsonData.labelName && <p className="text-base text-gray-500 mb-2">{jsonData.labelName}</p>}
                    <div className="flex items-center gap-2 flex-wrap mb-3">
                      {jsonData.isPreorder && <span className="bg-orange-100 text-orange-800 text-xs font-semibold px-2.5 py-1 rounded">Pre-order</span>}
                      <span className="text-sm text-gray-500">{jsonData.releaseDate ? new Date(jsonData.releaseDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Date TBA'}</span>
                    </div>
                    <div className="space-y-2">
                      {cloudUrls.tracks.slice(0, 3).map((track, i) => (
                        <div key={i} className="flex items-center gap-3 bg-gray-50 rounded p-2">
                          <span className="text-sm font-semibold text-gray-500 w-6">{track.track_number}.</span>
                          <p className="text-sm font-medium text-gray-900 flex-1 truncate">{track.title}</p>
                          <audio src={track.cloudinary_preview_url} controls className="w-48 h-8" />
                          <div className="bg-green-500 text-white text-sm font-bold px-4 py-2 rounded">£{track.price.toFixed(2)}</div>
                        </div>
                      ))}
                      {cloudUrls.tracks.length > 3 && (
                        <div className="text-sm text-blue-600 font-semibold p-2 bg-gray-50 rounded">
                          + {cloudUrls.tracks.length - 3} more track{cloudUrls.tracks.length - 3 !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex gap-4 mt-6">
                <button
                  onClick={resetAll}
                  className="px-6 py-3 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={publishToSite}
                  className="flex-1 px-6 py-3 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors flex items-center justify-center gap-2 text-lg font-semibold"
                >
                  <CheckCircle className="w-6 h-6" />
                  Publish Release to Main Site
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stage 4: Success */}
        {stage === 'success' && (
          <div className="bg-white rounded-lg shadow-lg p-8 text-center">
            <CheckCircle className="w-20 h-20 text-green-500 mx-auto mb-4" />
            <h1 className="text-3xl font-bold text-gray-900 mb-2">Release Published!</h1>
            <p className="text-gray-600 mb-4">Your release is now live on the main site.</p>
          </div>
        )}
      </div>
    </div>
  );
}