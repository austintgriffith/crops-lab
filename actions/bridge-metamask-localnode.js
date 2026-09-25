// Action: bridge-metamask-localnode — bridge-metamask with Ethereum set to your node in MetaMask's UI
// first (see mm-localnode.js). Uses the warm wallet-profile.
// wallet: metamask
process.env.THEN = "bridge-metamask";
require("./mm-localnode.js");
