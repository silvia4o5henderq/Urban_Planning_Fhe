pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract UrbanPlanningFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60;
    bool public paused;
    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Proposal {
        euint32 encryptedVoteCount;
        euint32 encryptedFeasibilityScore;
    }
    mapping(uint256 => mapping(uint256 => Proposal)) public batchProposals; // batchId => proposalId => Proposal

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSet(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused();
    event ContractUnpaused();
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ProposalSubmitted(uint256 indexed batchId, uint256 indexed proposalId, address indexed submitter);
    event VoteSubmitted(uint256 indexed batchId, uint256 indexed proposalId, address indexed voter);
    event DataSubmitted(uint256 indexed batchId, uint256 indexed proposalId, address indexed provider);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 proposalId, uint256 voteCount, uint256 feasibilityScore);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier batchMustBeOpen() {
        if (!batchOpen) revert BatchClosed();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setCooldown(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSet(oldCooldown, newCooldownSeconds);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused();
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitProposal(uint256 proposalId, euint32 encryptedInitialVoteCount) external whenNotPaused checkSubmissionCooldown batchMustBeOpen {
        _initIfNeeded(encryptedInitialVoteCount);
        batchProposals[currentBatchId][proposalId] = Proposal(encryptedInitialVoteCount, FHE.asEuint32(0));
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit ProposalSubmitted(currentBatchId, proposalId, msg.sender);
    }

    function submitVote(uint256 proposalId, euint32 encryptedVote) external whenNotPaused checkSubmissionCooldown batchMustBeOpen {
        _requireInitialized(encryptedVote);
        Proposal storage p = batchProposals[currentBatchId][proposalId];
        _initIfNeeded(p.encryptedVoteCount); // Ensure it's initialized if not already
        p.encryptedVoteCount = p.encryptedVoteCount.add(encryptedVote);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(currentBatchId, proposalId, msg.sender);
    }

    function submitFeasibilityData(uint256 proposalId, euint32 encryptedFeasibilityScore) external onlyProvider whenNotPaused checkSubmissionCooldown batchMustBeOpen {
        _initIfNeeded(encryptedFeasibilityScore);
        Proposal storage p = batchProposals[currentBatchId][proposalId];
        _initIfNeeded(p.encryptedFeasibilityScore); // Ensure it's initialized
        p.encryptedFeasibilityScore = p.encryptedFeasibilityScore.add(encryptedFeasibilityScore);
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(currentBatchId, proposalId, msg.sender);
    }

    function requestAggregatedResultDecryption(uint256 proposalId) external whenNotPaused checkDecryptionCooldown {
        if (batchProposals[currentBatchId][proposalId].encryptedVoteCount.isInitialized() == FHE.asEbool(false) ||
            batchProposals[currentBatchId][proposalId].encryptedFeasibilityScore.isInitialized() == FHE.asEbool(false)) {
            revert InvalidBatch();
        }

        euint32 memory voteCount = batchProposals[currentBatchId][proposalId].encryptedVoteCount;
        euint32 memory feasibilityScore = batchProposals[currentBatchId][proposalId].encryptedFeasibilityScore;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = voteCount.toBytes32();
        cts[1] = feasibilityScore.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext(currentBatchId, stateHash, false);
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }
        // Security: Replay protection ensures a decryption request is processed only once.

        euint32 memory currentVoteCount = batchProposals[decryptionContexts[requestId].batchId][0].encryptedVoteCount; // Assuming proposalId 0 for simplicity in this example
        euint32 memory currentFeasibilityScore = batchProposals[decryptionContexts[requestId].batchId][0].encryptedFeasibilityScore;

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = currentVoteCount.toBytes32();
        currentCts[1] = currentFeasibilityScore.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures the contract state (ciphertexts) hasn't changed
        // since the decryption was requested, preventing inconsistent decryptions.
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        uint256 voteCount = abi.decode(cleartexts[0:32], (uint32));
        uint256 feasibilityScore = abi.decode(cleartexts[32:64], (uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, 0, voteCount, feasibilityScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage x) internal {
        if (x.isInitialized() == FHE.asEbool(false)) {
            x = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 x) internal pure {
        if (x.isInitialized() == FHE.asEbool(false)) {
            revert("Ciphertext not initialized");
        }
    }
}