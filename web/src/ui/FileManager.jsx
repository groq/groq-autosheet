"use client"
import React, { useState, useCallback, useEffect } from 'react'

const FILES_STORAGE_KEY = 'autosheet.files.v2'
const CURRENT_FILE_KEY = 'autosheet.currentFile.v2'

// File format structure
function createNewFile(name) {
  return {
    id: crypto.randomUUID(),
    name: name || 'Untitled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    data: {
      sheets: {},
      activeSheet: 'Sheet1',
      cellFormats: {},
      scripts: [],
      activeScriptId: null,
      chats: [],
      activeChatId: null,
      // UI state
      showSheet: true,
      showScripts: true,
      showChat: true,
      paneWidths: [40, 30, 30],
      systemPrompt: 'You are a helpful assistant.',
      model: 'openai/gpt-oss-20b',
    }
  }
}

// Load all files from localStorage
export function loadFiles() {
  try {
    const raw = localStorage.getItem(FILES_STORAGE_KEY)
    if (raw) {
      const files = JSON.parse(raw)
      if (Array.isArray(files) && files.length > 0) {
        return files
      }
    }
  } catch (e) {
    console.error('Failed to load files:', e)
  }
  return []
}

// Save files to localStorage
export function saveFiles(files) {
  try {
    const data = JSON.stringify(files)
    localStorage.setItem(FILES_STORAGE_KEY, data)
    // Verify the save
    const saved = localStorage.getItem(FILES_STORAGE_KEY)
    if (!saved) {
      throw new Error('Failed to save files - localStorage returned null')
    }
    return true
  } catch (e) {
    alert('Failed to save files: ' + e.message)
    return false
  }
}

// Get current file ID
export function getCurrentFileId() {
  try {
    return localStorage.getItem(CURRENT_FILE_KEY) || null
  } catch {
    return null
  }
}

// Set current file ID
export function setCurrentFileId(fileId) {
  try {
    if (fileId) {
      localStorage.setItem(CURRENT_FILE_KEY, fileId)
    } else {
      localStorage.removeItem(CURRENT_FILE_KEY)
    }
  } catch (e) {
    console.error('Failed to set current file:', e)
  }
}

// Collect all current state from various localStorage keys
export function collectCurrentState() {
  const state = {
    sheets: {},
    activeSheet: 'Sheet1',
    cellFormats: {},
    scripts: [],
    activeScriptId: null,
    chats: [],
    activeChatId: null,
    showSheet: true,
    showScripts: true,
    showChat: true,
    paneWidths: [40, 30, 30],
    systemPrompt: 'You are a helpful assistant.',
    model: 'openai/gpt-oss-20b',
  }

  try {
    // Sheets data
    const sheetsRaw = localStorage.getItem('autosheet.sheets.v1')
    if (sheetsRaw) {
      const parsed = JSON.parse(sheetsRaw)
      state.sheets = parsed.sheets || {}
      state.activeSheet = parsed.activeSheet || 'Sheet1'
      state.cellFormats = parsed.formats || {}
    }

    // Cell formats (if stored separately)
    const formatsRaw = localStorage.getItem('autosheet.cellFormats.v1')
    if (formatsRaw) {
      state.cellFormats = JSON.parse(formatsRaw) || {}
    }

    // Scripts
    const scriptsRaw = localStorage.getItem('autosheet.scriptFiles.v1')
    if (scriptsRaw) {
      state.scripts = JSON.parse(scriptsRaw) || []
    }

    // Chats
    const chatsRaw = localStorage.getItem('autosheet.chats.v1')
    if (chatsRaw) {
      state.chats = JSON.parse(chatsRaw) || []
    }
    state.activeChatId = localStorage.getItem('autosheet.chats.activeId') || null

    // UI state
    state.showSheet = localStorage.getItem('autosheet.showSheet') !== 'false'
    state.showScripts = localStorage.getItem('autosheet.showScripts') !== 'false'
    state.showChat = localStorage.getItem('autosheet.showChat') !== 'false'

    const paneWidthsRaw = localStorage.getItem('autosheet.paneWidths')
    if (paneWidthsRaw) {
      try {
        state.paneWidths = JSON.parse(paneWidthsRaw)
      } catch {}
    }

    state.systemPrompt = localStorage.getItem('autosheet.chat.systemPrompt') || 'You are a helpful assistant.'
    state.model = localStorage.getItem('autosheet.chat.model') || 'openai/gpt-oss-20b'

  } catch (e) {
    console.error('Failed to collect current state:', e)
  }

  return state
}

// Apply file state to localStorage
export function applyFileState(fileData) {
  try {
    // Sheets and formats
    localStorage.setItem('autosheet.sheets.v1', JSON.stringify({
      sheets: fileData.sheets || {},
      activeSheet: fileData.activeSheet || 'Sheet1',
      formats: fileData.cellFormats || {}
    }))
    localStorage.setItem('autosheet.activeSheet', fileData.activeSheet || 'Sheet1')
    localStorage.setItem('autosheet.cellFormats.v1', JSON.stringify(fileData.cellFormats || {}))

    // Scripts
    if (fileData.scripts && fileData.scripts.length > 0) {
      localStorage.setItem('autosheet.scriptFiles.v1', JSON.stringify(fileData.scripts))
    } else {
      localStorage.removeItem('autosheet.scriptFiles.v1')
    }

    // Chats
    if (fileData.chats && fileData.chats.length > 0) {
      localStorage.setItem('autosheet.chats.v1', JSON.stringify(fileData.chats))
    } else {
      localStorage.removeItem('autosheet.chats.v1')
    }
    if (fileData.activeChatId) {
      localStorage.setItem('autosheet.chats.activeId', fileData.activeChatId)
    } else {
      localStorage.removeItem('autosheet.chats.activeId')
    }

    // UI state
    localStorage.setItem('autosheet.showSheet', String(fileData.showSheet !== false))
    localStorage.setItem('autosheet.showScripts', String(fileData.showScripts !== false))
    localStorage.setItem('autosheet.showChat', String(fileData.showChat !== false))
    
    if (fileData.paneWidths) {
      localStorage.setItem('autosheet.paneWidths', JSON.stringify(fileData.paneWidths))
    }

    localStorage.setItem('autosheet.chat.systemPrompt', fileData.systemPrompt || 'You are a helpful assistant.')
    localStorage.setItem('autosheet.chat.model', fileData.model || 'openai/gpt-oss-20b')

  } catch (e) {
    console.error('Failed to apply file state:', e)
    throw e
  }
}

export default function FileManager({ isOpen, onClose, currentFileName, onFileChange }) {
  const [files, setFiles] = useState(() => loadFiles())
  const [selectedFileId, setSelectedFileId] = useState(null)
  const [renamingId, setRenamingId] = useState(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [showNewFileDialog, setShowNewFileDialog] = useState(false)
  const [newFileName, setNewFileName] = useState('')

  // Refresh files when dialog opens
  useEffect(() => {
    if (isOpen) {
      setFiles(loadFiles())
      setSelectedFileId(getCurrentFileId())
    }
  }, [isOpen])

  const handleNewFile = useCallback(() => {
    // Check if there's unsaved work
    const currentId = getCurrentFileId()
    if (!currentId && currentFileName) {
      // There's work but no saved file
      if (!window.confirm('You have unsaved work. Creating a new file will save your current work first. Continue?')) {
        return
      }
    }
    setNewFileName('Untitled')
    setShowNewFileDialog(true)
  }, [currentFileName])

  const createFile = useCallback(() => {
    try {
      // First, save current work if there's any unsaved content
      const currentId = getCurrentFileId()
      let latestFiles = loadFiles() // Get fresh files from localStorage
      
      if (currentId) {
        // Update existing file with current state before creating new one
        const state = collectCurrentState()
        latestFiles = latestFiles.map(f => 
          f.id === currentId 
            ? { ...f, data: state, updatedAt: Date.now() }
            : f
        )
      } else if (currentFileName) {
        // If there's work but no current file ID, save it as a new file first
        const state = collectCurrentState()
        const currentFile = {
          ...createNewFile(currentFileName),
          data: state
        }
        latestFiles = [...latestFiles, currentFile]
      }
      
      // Now create the new file
      const name = newFileName.trim() || 'Untitled'
      const file = createNewFile(name)
      const updatedFiles = [...latestFiles, file]
      
      // Save all files including the new one
      const saveSuccess = saveFiles(updatedFiles)
      if (!saveSuccess) {
        return
      }
      setFiles(updatedFiles)
      
      // Apply the new file's clean state to localStorage
      applyFileState(file.data)
      setCurrentFileId(file.id)
      
      // Close dialog first
      setShowNewFileDialog(false)
      setNewFileName('')
      onFileChange(file.name, file.id)
      onClose() // Close the FileManager dialog
      
      // Add a small delay to ensure all localStorage operations complete
      setTimeout(() => {
        // Force a page reload to ensure all components pick up the new state
        window.location.reload()
      }, 100)
    } catch (error) {
      alert('Failed to create file: ' + error.message)
    }
  }, [newFileName, onFileChange, currentFileName, onClose])

  const handleSave = useCallback(() => {
    const currentId = getCurrentFileId()
    const state = collectCurrentState()
    
    if (currentId) {
      // Update existing file
      const updatedFiles = files.map(f => 
        f.id === currentId 
          ? { ...f, data: state, updatedAt: Date.now() }
          : f
      )
      setFiles(updatedFiles)
      saveFiles(updatedFiles)
    } else {
      // Create new file for current work
      const name = currentFileName || 'Untitled'
      const file = {
        ...createNewFile(name),
        data: state
      }
      const updatedFiles = [...files, file]
      setFiles(updatedFiles)
      saveFiles(updatedFiles)
      setCurrentFileId(file.id)
      onFileChange(file.name, file.id)
    }
    onClose()
  }, [files, currentFileName, onFileChange, onClose])

  const handleSaveAs = useCallback(() => {
    setNewFileName(currentFileName || 'Untitled Copy')
    setShowNewFileDialog(true)
  }, [currentFileName])

  const createSaveAsFile = useCallback(() => {
    const name = newFileName.trim() || 'Untitled'
    const state = collectCurrentState()
    const file = {
      ...createNewFile(name),
      data: state
    }
    const updatedFiles = [...files, file]
    setFiles(updatedFiles)
    saveFiles(updatedFiles)
    setCurrentFileId(file.id)
    onFileChange(file.name, file.id)
    setShowNewFileDialog(false)
    setNewFileName('')
    onClose()
  }, [files, newFileName, onFileChange, onClose])

  const handleLoad = useCallback((fileId) => {
    const file = files.find(f => f.id === fileId)
    if (!file) return

    if (!window.confirm(`Load "${file.name}"? Any unsaved changes will be lost.`)) {
      return
    }

    try {
      applyFileState(file.data)
      setCurrentFileId(file.id)
      onFileChange(file.name, file.id)
      
      // Small delay then reload
      setTimeout(() => {
        // Force a page reload to ensure all components pick up the new state
        window.location.reload()
      }, 50)
    } catch (e) {
      alert('Failed to load file: ' + e.message)
    }
  }, [files, onFileChange])

  const handleDelete = useCallback((fileId) => {
    const file = files.find(f => f.id === fileId)
    if (!file) return

    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) {
      return
    }

    const updatedFiles = files.filter(f => f.id !== fileId)
    setFiles(updatedFiles)
    saveFiles(updatedFiles)

    // If deleting current file, clear current file ID
    if (getCurrentFileId() === fileId) {
      setCurrentFileId(null)
      onFileChange(null, null)
    }
  }, [files, onFileChange])

  const handleRename = useCallback((fileId) => {
    const file = files.find(f => f.id === fileId)
    if (!file) return
    setRenamingId(fileId)
    setRenamingValue(file.name)
  }, [files])

  const commitRename = useCallback(() => {
    if (!renamingId || !renamingValue.trim()) {
      setRenamingId(null)
      return
    }

    const updatedFiles = files.map(f => 
      f.id === renamingId 
        ? { ...f, name: renamingValue.trim(), updatedAt: Date.now() }
        : f
    )
    setFiles(updatedFiles)
    saveFiles(updatedFiles)

    // Update current file name if renaming current file
    if (getCurrentFileId() === renamingId) {
      const file = updatedFiles.find(f => f.id === renamingId)
      onFileChange(file.name, file.id)
    }

    setRenamingId(null)
    setRenamingValue('')
  }, [files, renamingId, renamingValue, onFileChange])

  const formatDate = (timestamp) => {
    return new Date(timestamp).toLocaleString()
  }

  if (!isOpen) return null

  return (
    <div className="file-manager-overlay">
      <div className="file-manager-dialog">
        <div className="file-manager-header">
          <h2>File Manager</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        
        <div className="file-manager-toolbar">
          <button onClick={handleNewFile}>New File</button>
          <button onClick={handleSave}>Save</button>
          <button onClick={handleSaveAs}>Save As...</button>
        </div>

        <div className="file-manager-list">
          {files.length === 0 ? (
            <div className="empty-message">No saved files</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Modified</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map(file => (
                  <tr 
                    key={file.id} 
                    className={selectedFileId === file.id ? 'selected' : ''}
                    onClick={() => setSelectedFileId(file.id)}
                  >
                    <td>
                      {renamingId === file.id ? (
                        <input
                          type="text"
                          value={renamingValue}
                          onChange={(e) => setRenamingValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      ) : (
                        <span className="file-name">
                          {file.name}.as
                          {getCurrentFileId() === file.id && <span className="current-badge"> (current)</span>}
                        </span>
                      )}
                    </td>
                    <td>{formatDate(file.updatedAt)}</td>
                    <td>
                      <div className="file-actions">
                        <button onClick={(e) => { e.stopPropagation(); handleLoad(file.id); }}>
                          Load
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); handleRename(file.id); }}>
                          Rename
                        </button>
                        <button 
                          className="delete-btn"
                          onClick={(e) => { e.stopPropagation(); handleDelete(file.id); }}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {showNewFileDialog && (
          <div className="new-file-dialog">
            <div className="dialog-content">
              <h3>{newFileName.includes('Copy') ? 'Save As' : 'New File'}</h3>
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="Enter file name"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (newFileName.includes('Copy')) {
                      createSaveAsFile()
                    } else {
                      createFile()
                    }
                  }
                  if (e.key === 'Escape') {
                    setShowNewFileDialog(false)
                    setNewFileName('')
                  }
                }}
              />
              <div className="dialog-buttons">
                <button onClick={() => {
                  if (newFileName.includes('Copy')) {
                    createSaveAsFile()
                  } else {
                    createFile()
                  }
                }}>
                  {newFileName.includes('Copy') ? 'Save' : 'Create'}
                </button>
                <button onClick={() => { setShowNewFileDialog(false); setNewFileName(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .file-manager-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
        }

        .file-manager-dialog {
          background: white;
          border-radius: 8px;
          width: 90%;
          max-width: 800px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
          position: relative; /* establish stacking context for inner modal */
        }

        .file-manager-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px;
          border-bottom: 1px solid #e0e0e0;
        }

        .file-manager-header h2 {
          margin: 0;
          font-size: 24px;
          color: #333;
        }

        .close-btn {
          background: none;
          border: none;
          font-size: 28px;
          cursor: pointer;
          color: #666;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .close-btn:hover {
          color: #333;
        }

        .file-manager-toolbar {
          padding: 15px 20px;
          border-bottom: 1px solid #e0e0e0;
          display: flex;
          gap: 10px;
        }

        .file-manager-toolbar button {
          padding: 8px 16px;
          background: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }

        .file-manager-toolbar button:hover {
          background: #0056b3;
        }

        .file-manager-list {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
        }

        /* Prevent global sticky header rules from affecting this table */
        .file-manager-list thead th { position: static; z-index: auto; background: #fff; }

        .empty-message {
          text-align: center;
          color: #666;
          padding: 40px;
          font-size: 16px;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th {
          text-align: left;
          padding: 10px;
          border-bottom: 2px solid #e0e0e0;
          font-weight: 600;
          color: #333;
        }

        td {
          padding: 10px;
          border-bottom: 1px solid #f0f0f0;
        }

        tr {
          cursor: pointer;
        }

        tr:hover {
          background: #f8f9fa;
        }

        tr.selected {
          background: #e3f2fd;
        }

        .file-name {
          font-weight: 500;
        }

        .current-badge {
          color: #28a745;
          font-size: 12px;
          font-weight: normal;
        }

        .file-actions {
          display: flex;
          gap: 8px;
        }

        .file-actions button {
          padding: 4px 12px;
          background: #f8f9fa;
          border: 1px solid #dee2e6;
          border-radius: 3px;
          cursor: pointer;
          font-size: 13px;
        }

        .file-actions button:hover {
          background: #e9ecef;
        }

        .delete-btn {
          color: #dc3545;
        }

        .delete-btn:hover {
          background: #dc3545 !important;
          color: white;
          border-color: #dc3545;
        }

        .new-file-dialog {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10001; /* above any content inside dialog, including sticky headers */
        }

        .dialog-content {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
          width: 400px;
          position: relative;
          z-index: 10002;
        }

        .dialog-content h3 {
          margin: 0 0 20px 0;
          color: #333;
        }

        .dialog-content input {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          margin-bottom: 20px;
        }

        .dialog-buttons {
          display: flex;
          gap: 10px;
          justify-content: flex-end;
        }

        .dialog-buttons button {
          padding: 8px 20px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }

        .dialog-buttons button:first-child {
          background: #007bff;
          color: white;
        }

        .dialog-buttons button:first-child:hover {
          background: #0056b3;
        }

        .dialog-buttons button:last-child {
          background: #6c757d;
          color: white;
        }

        .dialog-buttons button:last-child:hover {
          background: #5a6268;
        }

        input[type="text"] {
          font-family: inherit;
        }
      `}</style>
    </div>
  )
}
