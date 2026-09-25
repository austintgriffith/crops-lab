// Action: buy-metamask-localnode — buy-metamask with Ethereum set to your node in MetaMask's UI
// first (see mm-localnode.js). Uses the warm wallet-profile. Capture-only.
// wallet: metamask
process.env.THEN = "buy-metamask";
require("./mm-localnode.js");
