// Action: deposit-aave-localnode — deposit-aave with Ethereum set to your node in MetaMask's UI
// first (see mm-localnode.js). Uses the warm wallet-profile.
// wallet: metamask
process.env.THEN = "deposit-aave";
require("./mm-localnode.js");
