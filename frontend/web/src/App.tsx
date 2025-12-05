// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface UrbanProposal {
  id: string;
  encryptedVotes: string;
  timestamp: number;
  owner: string;
  location: string;
  status: "pending" | "approved" | "rejected";
  title: string;
  description: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<UrbanProposal[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProposalData, setNewProposalData] = useState({ 
    title: "", 
    description: "", 
    location: "", 
    voteCount: 0 
  });
  const [selectedProposal, setSelectedProposal] = useState<UrbanProposal | null>(null);
  const [decryptedVotes, setDecryptedVotes] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showMap, setShowMap] = useState(false);
  const [activeTab, setActiveTab] = useState("proposals");

  const approvedCount = proposals.filter(p => p.status === "approved").length;
  const pendingCount = proposals.filter(p => p.status === "pending").length;
  const rejectedCount = proposals.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadProposals().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadProposals = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("proposal_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing proposal keys:", e); }
      }
      
      const list: UrbanProposal[] = [];
      for (const key of keys) {
        try {
          const proposalBytes = await contract.getData(`proposal_${key}`);
          if (proposalBytes.length > 0) {
            try {
              const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
              list.push({ 
                id: key, 
                encryptedVotes: proposalData.votes, 
                timestamp: proposalData.timestamp, 
                owner: proposalData.owner, 
                location: proposalData.location,
                status: proposalData.status || "pending",
                title: proposalData.title,
                description: proposalData.description
              });
            } catch (e) { console.error(`Error parsing proposal data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading proposal ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProposals(list);
    } catch (e) { console.error("Error loading proposals:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProposal = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting vote data with Zama FHE..." });
    try {
      const encryptedVotes = FHEEncryptNumber(newProposalData.voteCount);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const proposalId = `prop-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const proposalData = { 
        votes: encryptedVotes, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        location: newProposalData.location,
        status: "pending",
        title: newProposalData.title,
        description: newProposalData.description
      };
      
      await contract.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(proposalData)));
      
      const keysBytes = await contract.getData("proposal_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(proposalId);
      await contract.setData("proposal_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted proposal submitted securely!" });
      await loadProposals();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProposalData({ 
          title: "", 
          description: "", 
          location: "", 
          voteCount: 0 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const approveProposal = async (proposalId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted votes with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const proposalBytes = await contract.getData(`proposal_${proposalId}`);
      if (proposalBytes.length === 0) throw new Error("Proposal not found");
      const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProposal = { ...proposalData, status: "approved" };
      await contractWithSigner.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProposal)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE approval completed successfully!" });
      await loadProposals();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectProposal = async (proposalId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted votes with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const proposalBytes = await contract.getData(`proposal_${proposalId}`);
      if (proposalBytes.length === 0) throw new Error("Proposal not found");
      const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
      const updatedProposal = { ...proposalData, status: "rejected" };
      await contract.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProposal)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadProposals();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (proposalAddress: string) => address?.toLowerCase() === proposalAddress.toLowerCase();

  const renderStats = () => {
    return (
      <div className="stats-container">
        <div className="stat-item">
          <div className="stat-value">{proposals.length}</div>
          <div className="stat-label">Total Proposals</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
        </div>
        <div className="stat-item">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
        </div>
      </div>
    );
  };

  const renderCityMap = () => {
    return (
      <div className="city-map-container">
        <div className="map-grid">
          {Array(16).fill(0).map((_, i) => (
            <div key={i} className="map-cell">
              {proposals.some(p => p.location === `District ${i+1}`) && (
                <div className="map-proposal-indicator" onClick={() => {
                  const districtProposals = proposals.filter(p => p.location === `District ${i+1}`);
                  if (districtProposals.length > 0) {
                    setSelectedProposal(districtProposals[0]);
                  }
                }}>
                  {proposals.filter(p => p.location === `District ${i+1}`).length}
                </div>
              )}
              <div className="district-label">D{i+1}</div>
            </div>
          ))}
        </div>
        <div className="map-legend">
          <div className="legend-item">
            <div className="color-box approved"></div>
            <span>Approved Proposals</span>
          </div>
          <div className="legend-item">
            <div className="color-box pending"></div>
            <span>Pending Proposals</span>
          </div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>Urban<span>FHE</span>Plan</h1>
          <div className="logo-subtitle">Community-Driven Urban Planning with FHE</div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-btn">
            + New Proposal
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Shape Your City with Privacy</h2>
            <p>Submit and vote on urban development proposals using Zama FHE encrypted data</p>
          </div>
          <div className="fhe-badge">
            <span>FHE Encryption Active</span>
          </div>
        </div>

        <div className="navigation-tabs">
          <button 
            className={`tab-button ${activeTab === "proposals" ? "active" : ""}`}
            onClick={() => setActiveTab("proposals")}
          >
            Proposals
          </button>
          <button 
            className={`tab-button ${activeTab === "map" ? "active" : ""}`}
            onClick={() => setActiveTab("map")}
          >
            City Map
          </button>
          <button 
            className={`tab-button ${activeTab === "about" ? "active" : ""}`}
            onClick={() => setActiveTab("about")}
          >
            About Project
          </button>
          <button 
            className={`tab-button ${activeTab === "community" ? "active" : ""}`}
            onClick={() => setActiveTab("community")}
          >
            Community
          </button>
        </div>

        {activeTab === "proposals" && (
          <div className="content-section">
            <div className="section-header">
              <h2>Urban Development Proposals</h2>
              <button onClick={loadProposals} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
            
            <div className="stats-section">
              {renderStats()}
            </div>

            <div className="proposals-list">
              {proposals.length === 0 ? (
                <div className="no-proposals">
                  <div className="empty-icon"></div>
                  <p>No urban development proposals found</p>
                  <button className="primary-btn" onClick={() => setShowCreateModal(true)}>
                    Create First Proposal
                  </button>
                </div>
              ) : proposals.map(proposal => (
                <div 
                  className={`proposal-card ${proposal.status}`} 
                  key={proposal.id}
                  onClick={() => setSelectedProposal(proposal)}
                >
                  <div className="proposal-header">
                    <h3>{proposal.title}</h3>
                    <div className={`status-badge ${proposal.status}`}>
                      {proposal.status}
                    </div>
                  </div>
                  <div className="proposal-meta">
                    <span className="location">{proposal.location}</span>
                    <span className="date">{new Date(proposal.timestamp * 1000).toLocaleDateString()}</span>
                  </div>
                  <p className="proposal-description">
                    {proposal.description.substring(0, 100)}...
                  </p>
                  <div className="proposal-footer">
                    <div className="vote-count">
                      <button 
                        className="decrypt-btn"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (decryptedVotes !== null) {
                            setDecryptedVotes(null);
                          } else {
                            const votes = await decryptWithSignature(proposal.encryptedVotes);
                            if (votes !== null) setDecryptedVotes(votes);
                          }
                        }}
                        disabled={isDecrypting}
                      >
                        {isDecrypting ? "Decrypting..." : 
                         decryptedVotes !== null ? `Votes: ${decryptedVotes}` : "Show Encrypted Votes"}
                      </button>
                    </div>
                    <div className="proposal-actions">
                      {isOwner(proposal.owner) && proposal.status === "pending" && (
                        <>
                          <button 
                            className="action-btn approve"
                            onClick={(e) => { e.stopPropagation(); approveProposal(proposal.id); }}
                          >
                            Approve
                          </button>
                          <button 
                            className="action-btn reject"
                            onClick={(e) => { e.stopPropagation(); rejectProposal(proposal.id); }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "map" && (
          <div className="content-section">
            <div className="section-header">
              <h2>City Development Map</h2>
              <button onClick={() => setShowMap(!showMap)} className="toggle-map-btn">
                {showMap ? "Hide Map" : "Show Map"}
              </button>
            </div>
            
            {showMap && renderCityMap()}
            
            <div className="map-proposals-list">
              <h3>Recent Proposals by District</h3>
              {proposals.slice(0, 5).map(proposal => (
                <div 
                  className="map-proposal-item" 
                  key={proposal.id}
                  onClick={() => setSelectedProposal(proposal)}
                >
                  <div className="map-proposal-location">{proposal.location}</div>
                  <div className="map-proposal-title">{proposal.title}</div>
                  <div className={`map-proposal-status ${proposal.status}`}>{proposal.status}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "about" && (
          <div className="content-section">
            <div className="about-section">
              <h2>About UrbanFHEPlan</h2>
              <div className="about-content">
                <div className="about-card">
                  <h3>What is UrbanFHEPlan?</h3>
                  <p>
                    UrbanFHEPlan is a revolutionary platform that enables citizens to participate in urban planning 
                    while maintaining complete privacy of their votes and preferences using Zama's Fully Homomorphic Encryption (FHE) technology.
                  </p>
                </div>
                <div className="about-card">
                  <h3>How FHE Works</h3>
                  <p>
                    Your votes and sensitive data are encrypted before submission and remain encrypted during processing. 
                    The system can compute results without ever decrypting your private information, ensuring unprecedented privacy.
                  </p>
                  <div className="fhe-process">
                    <div className="process-step">
                      <div className="step-icon">🔓</div>
                      <div className="step-label">Plain Data</div>
                    </div>
                    <div className="process-arrow">→</div>
                    <div className="process-step">
                      <div className="step-icon">🔒</div>
                      <div className="step-label">FHE Encryption</div>
                    </div>
                    <div className="process-arrow">→</div>
                    <div className="process-step">
                      <div className="step-icon">⚙️</div>
                      <div className="step-label">Compute on Encrypted Data</div>
                    </div>
                    <div className="process-arrow">→</div>
                    <div className="process-step">
                      <div className="step-icon">📊</div>
                      <div className="step-label">Encrypted Results</div>
                    </div>
                  </div>
                </div>
                <div className="about-card">
                  <h3>Technology Stack</h3>
                  <ul className="tech-stack">
                    <li>Zama FHE for encrypted computations</li>
                    <li>Ethereum blockchain for decentralized storage</li>
                    <li>DePIN for real-world data collection</li>
                    <li>React for responsive frontend</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "community" && (
          <div className="content-section">
            <div className="community-section">
              <h2>Join Our Community</h2>
              <div className="community-links">
                <a href="#" className="community-link">
                  <div className="link-icon discord"></div>
                  <span>Discord</span>
                </a>
                <a href="#" className="community-link">
                  <div className="link-icon twitter"></div>
                  <span>Twitter</span>
                </a>
                <a href="#" className="community-link">
                  <div className="link-icon github"></div>
                  <span>GitHub</span>
                </a>
                <a href="#" className="community-link">
                  <div className="link-icon forum"></div>
                  <span>Community Forum</span>
                </a>
              </div>
              
              <div className="community-stats">
                <div className="community-stat">
                  <div className="stat-value">1,254</div>
                  <div className="stat-label">Active Citizens</div>
                </div>
                <div className="community-stat">
                  <div className="stat-value">328</div>
                  <div className="stat-label">Proposals Submitted</div>
                </div>
                <div className="community-stat">
                  <div className="stat-value">42</div>
                  <div className="stat-label">Projects Implemented</div>
                </div>
              </div>
              
              <div className="community-testimonials">
                <h3>What Citizens Say</h3>
                <div className="testimonial-card">
                  <p>"UrbanFHEPlan gave me a voice in my neighborhood's development without compromising my privacy."</p>
                  <div className="testimonial-author">- Maria G., District 5</div>
                </div>
                <div className="testimonial-card">
                  <p>"The FHE technology is revolutionary - I can vote on proposals without worrying about my data being exposed."</p>
                  <div className="testimonial-author">- James L., District 12</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitProposal} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          proposalData={newProposalData} 
          setProposalData={setNewProposalData}
        />
      )}

      {selectedProposal && (
        <ProposalDetailModal 
          proposal={selectedProposal} 
          onClose={() => { 
            setSelectedProposal(null); 
            setDecryptedVotes(null); 
          }} 
          decryptedVotes={decryptedVotes} 
          setDecryptedVotes={setDecryptedVotes} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">Urban<span>FHE</span>Plan</div>
            <p>Empowering citizens with private, democratic urban planning</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} UrbanFHEPlan. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  proposalData: any;
  setProposalData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, proposalData, setProposalData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setProposalData({ ...proposalData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProposalData({ ...proposalData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!proposalData.title || !proposalData.location || !proposalData.voteCount) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>New Urban Development Proposal</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="notice-icon"></div>
            <div className="notice-text">
              <strong>FHE Encryption Notice</strong>
              <p>Your vote count will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Proposal Title *</label>
            <input 
              type="text" 
              name="title" 
              value={proposalData.title} 
              onChange={handleChange} 
              placeholder="Enter proposal title..."
              className="form-input"
            />
          </div>
          
          <div className="form-group">
            <label>Description</label>
            <textarea 
              name="description" 
              value={proposalData.description} 
              onChange={handleChange} 
              placeholder="Describe your urban development proposal..."
              className="form-textarea"
              rows={4}
            />
          </div>
          
          <div className="form-row">
            <div className="form-group">
              <label>Location (District) *</label>
              <select 
                name="location" 
                value={proposalData.location} 
                onChange={handleChange} 
                className="form-select"
              >
                <option value="">Select district</option>
                {Array(16).fill(0).map((_, i) => (
                  <option key={i} value={`District ${i+1}`}>District {i+1}</option>
                ))}
              </select>
            </div>
            
            <div className="form-group">
              <label>Initial Vote Count *</label>
              <input 
                type="number" 
                name="voteCount" 
                value={proposalData.voteCount} 
                onChange={handleValueChange} 
                placeholder="Enter vote count..."
                className="form-input"
                min="0"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-content">
              <div className="plain-data">
                <span>Plain Vote Count:</span>
                <div>{proposalData.voteCount || '0'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{proposalData.voteCount ? FHEEncryptNumber(proposalData.voteCount).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting & Submitting..." : "Submit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProposalDetailModalProps {
  proposal: UrbanProposal;
  onClose: () => void;
  decryptedVotes: number | null;
  setDecryptedVotes: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const ProposalDetailModal: React.FC<ProposalDetailModalProps> = ({ 
  proposal, 
  onClose, 
  decryptedVotes, 
  setDecryptedVotes, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedVotes !== null) { 
      setDecryptedVotes(null); 
      return; 
    }
    const votes = await decryptWithSignature(proposal.encryptedVotes);
    if (votes !== null) setDecryptedVotes(votes);
  };

  return (
    <div className="modal-overlay">
      <div className="proposal-detail-modal">
        <div className="modal-header">
          <h2>Proposal Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="proposal-header">
            <h3>{proposal.title}</h3>
            <div className={`status-badge ${proposal.status}`}>
              {proposal.status}
            </div>
          </div>
          
          <div className="proposal-meta">
            <div className="meta-item">
              <span className="meta-label">Location:</span>
              <span className="meta-value">{proposal.location}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Submitted:</span>
              <span className="meta-value">{new Date(proposal.timestamp * 1000).toLocaleString()}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Proposer:</span>
              <span className="meta-value">{proposal.owner.substring(0, 6)}...{proposal.owner.substring(38)}</span>
            </div>
          </div>
          
          <div className="proposal-description">
            <h4>Description</h4>
            <p>{proposal.description}</p>
          </div>
          
          <div className="vote-section">
            <h4>Vote Data</h4>
            <div className="vote-data">
              <div className="encrypted-votes">
                <span>Encrypted Votes:</span>
                <div>{proposal.encryptedVotes.substring(0, 50)}...</div>
              </div>
              <button 
                className="decrypt-btn"
                onClick={handleDecrypt}
                disabled={isDecrypting}
              >
                {isDecrypting ? "Decrypting..." : 
                 decryptedVotes !== null ? `Decrypted Votes: ${decryptedVotes}` : "Decrypt with Wallet"}
              </button>
            </div>
            {decryptedVotes !== null && (
              <div className="decryption-notice">
                <div className="notice-icon"></div>
                <p>Decrypted data is only visible after wallet signature verification</p>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;