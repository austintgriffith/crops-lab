// Action: swap-uniswap-localnode — swap-uniswap with Ethereum set to your node in MetaMask's UI
// first (see mm-localnode.js). Uses the warm wallet-profile.
// wallet: metamask
process.env.THEN = "swap-uniswap";
require("./mm-localnode.js");
