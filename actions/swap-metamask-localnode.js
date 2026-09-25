// Action: swap-metamask-localnode — swap-metamask with Ethereum set to your node in MetaMask's UI
// first (see mm-localnode.js). Uses the warm wallet-profile.
// wallet: metamask
process.env.THEN = "swap-metamask";
require("./mm-localnode.js");
