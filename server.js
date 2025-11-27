const express = require('express');
const bodyParser = require('body-parser');
const Web3 = require('web3');

// Load configuration and environment variables
// It's assumed config.json contains cEthAddress and cEthAbi
const config = require('./config.json');

// --- Environment Variables (Security Critical) ---
// Use robust, uppercase environment variable names for security and convention.
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const INFURA_API_KEY = process.env.INFURA_API_KEY;

if (!WALLET_PRIVATE_KEY || !INFURA_API_KEY) {
    console.error("FATAL: WALLET_PRIVATE_KEY or INFURA_API_KEY not set in environment variables.");
    process.exit(1);
}

// Initialize Web3
const web3Url = `https://mainnet.infura.io/v3/${INFURA_API_KEY}`;
const web3 = new Web3(web3Url);

// Add wallet to the session.
// NOTE: For high-security, production environments, consider using an external Key Management Service (KMS)
// instead of loading the private key directly into server memory.
web3.eth.accounts.wallet.add(WALLET_PRIVATE_KEY);
const myWalletAddress = web3.eth.accounts.wallet[0].address;

// Contract initialization
const cEthAddress = config.cEthAddress;
const cEthAbi = config.cEthAbi;
const cEthContract = new web3.eth.Contract(cEthAbi, cEthAddress);

// Express setup
const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/**
 * Helper function to send a JSON error response.
 * @param {*} res - Express response object.
 * @param {string} message - User-friendly error message.
 * @param {number} status - HTTP status code.
 * @param {*} error - The raw error object for logging.
 */
const sendError = (res, message, status, error) => {
    console.error(`[API Error] Status ${status}: ${message}`, error);
    return res.status(status).json({
        error: message,
        // Optionally include error details only in development mode
        details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
};

// --- API Routes ---

/**
 * GET: Retrieves the underlying ETH balance supplied to the Compound protocol.
 * Route: /protocol-balance/eth/
 */
app.route('/protocol-balance/eth/').get(async (req, res) => {
    try {
        const result = await cEthContract.methods.balanceOfUnderlying(myWalletAddress).call();
        const balanceOfUnderlying = web3.utils.fromWei(result, 'ether');
        return res.json({ balance: balanceOfUnderlying, unit: 'ETH' });
    } catch (error) {
        return sendError(res, 'Failed to fetch underlying balance.', 500, error);
    }
});

/**
 * GET: Retrieves the native ETH balance of the wallet.
 * Route: /wallet-balance/eth/
 */
app.route('/wallet-balance/eth/').get(async (req, res) => {
    try {
        const result = await web3.eth.getBalance(myWalletAddress);
        const ethBalance = web3.utils.fromWei(result, 'ether');
        return res.json({ balance: ethBalance, unit: 'ETH' });
    } catch (error) {
        return sendError(res, 'Failed to fetch native wallet balance.', 500, error);
    }
});

/**
 * GET: Retrieves the cETH (cToken) balance of the wallet.
 * Route: /wallet-balance/ceth/
 */
app.route('/wallet-balance/ceth/').get(async (req, res) => {
    try {
        const result = await cEthContract.methods.balanceOf(myWalletAddress).call();
        
        // cTokens typically have 8 decimals. Using custom division is clearer than magic numbers.
        // NOTE: In a real app, use the contract's `decimals()` method to be safe.
        const cTokenBalance = parseFloat(result) / 1e8; 
        
        return res.json({ balance: cTokenBalance.toString(), unit: 'cETH' });
    } catch (error) {
        return sendError(res, 'Failed to fetch cToken balance.', 500, error);
    }
});

/**
 * GET: Supplies (Mints) ETH to the Compound protocol.
 * Route: /supply/eth/:amount
 */
app.route('/supply/eth/:amount').get(async (req, res) => {
    const ethAmount = req.params.amount;

    if (isNaN(ethAmount) || parseFloat(ethAmount) <= 0) {
        return sendError(res, 'Invalid ETH amount provided.', 400, new Error('Invalid input amount.'));
    }

    try {
        // Fetch dynamic gas price (EIP-1559 is preferred, but getGasPrice is a simple alternative for legacy systems)
        const gasPrice = await web3.eth.getGasPrice();
        const valueInWei = web3.utils.toWei(ethAmount, 'ether');

        const tx = cEthContract.methods.mint().send({
            from: myWalletAddress,
            // Gas limit should be estimated, but kept constant here for simplicity (500k is a safe high limit)
            gas: web3.utils.toHex(500000), 
            gasPrice: web3.utils.toHex(gasPrice),
            value: web3.utils.toHex(valueInWei)
        });

        const receipt = await tx;
        return res.status(200).json({ 
            status: 'Success', 
            transactionHash: receipt.transactionHash 
        });
    } catch (error) {
        return sendError(res, 'Transaction failed during supply (mint) operation.', 500, error);
    }
});

/**
 * GET: Redeems cTokens for the underlying ETH.
 * Route: /redeem/eth/:cTokenAmount
 */
app.route('/redeem/eth/:cTokenAmount').get(async (req, res) => {
    const cTokenAmount = req.params.cTokenAmount;
    
    if (isNaN(cTokenAmount) || parseFloat(cTokenAmount) <= 0) {
        return sendError(res, 'Invalid cToken amount provided.', 400, new Error('Invalid input amount.'));
    }

    try {
        // Convert cToken amount (e.g., 8 decimals) back to Wei-like unit (1e8)
        const amountInContractUnits = web3.utils.toBN(cTokenAmount * 1e8);
        const gasPrice = await web3.eth.getGasPrice();

        const tx = cEthContract.methods.redeem(amountInContractUnits).send({
            from: myWalletAddress,
            gas: web3.utils.toHex(500000), 
            gasPrice: web3.utils.toHex(gasPrice)
        });

        const receipt = await tx;
        return res.status(200).json({ 
            status: 'Success', 
            transactionHash: receipt.transactionHash 
        });
    } catch (error) {
        return sendError(res, 'Transaction failed during redeem operation.', 500, error);
    }
});

// Start the server
app.listen(PORT, () => console.log(`API server running on port ${PORT}`));
