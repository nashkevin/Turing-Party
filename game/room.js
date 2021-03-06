// Class definition for a Room.

const WebSocket = require('ws');
const fs = require('fs');

// Numbers of players (humans + robots)
const MAX_SIZE = 8;

// Max length for chat messages.
const MAX_MESSAGE_LENGTH = 80;

// Avatars identifying players. Each name refers to an image.
const AVATARS = ['bull', 'chick', 'crab', 'fox', 'hedgehog', 'hippo',
    'koala', 'lemur', 'pig', 'tekin', 'tiger', 'whale', 'zebra'];

// Prompts that the game can display when players are quiet.
const PROMPT_FILENAME = __dirname + '/prompts.txt';

// How long to wait after the most recent message before displaying a prompt.
const PROMPT_SILENCE_DURATION_MS = 10 * 1000;

// How long to wait after the last prompt before displaying another.
const PROMPT_COOLDOWN_MS = 30 * 1000;

const STATES = {
    PREGAME: 1,
    GAME: 2,
    VOTING: 3,
    RESULTS: 4
};

// Point values for computing scores.
const SCORES = {
    GUESS_RIGHT: 20,     // this player guessed another player correctly
    GUESS_WRONG : -20,   // this player guessed another player wrong
    IS_GUESSED_RIGHT: 0, // this player was identified correctly
    IS_GUESSED_WRONG: 30 // this player fooled another player
};

var method = Room.prototype;

function Room(maxSize) {
    // Set of WebSockets corresponding to human players.
    this.humans = new Set();
    // Maps from client to a boolean of whether or not they are ready to vote.
    this.readyMap = new Map();

    // Set of all bots. Each bot should have a "send" method:
    // function send(message, sender)
    // that delivers the message to the bot. The sender can be null.
    // The bot should send messages by calling "broadcast" on this room.
    this.bots = new Set();

    // The maximum size for the room (humans + bots).
    if (maxSize) {
        this.maxSize = maxSize;
    } else {
        this.maxSize = MAX_SIZE;
    }

    // Each player will receive an ID (one of the avatar strings) upon joining
    // the room. The IDs will be in random order.
    this._remainingPlayerIds = AVATARS.slice();
    // Shuffle. https://css-tricks.com/snippets/javascript/shuffle-array/
    this._remainingPlayerIds.sort(function() {return 0.5 - Math.random()});

    // Randomize the prompts.
    this._prompts = fs.readFileSync(PROMPT_FILENAME).toString().split("\n");
    this._prompts.sort(function() {return 0.5 - Math.random()});

    this._playerToId = new WeakMap();
    this._idToPlayer = new Map();

    // Maps from player to ballot. Ballots are maps from player IDs to the
    // string "human" or "robot".
    this._ballots = new Map();

    // Keep track of when the last message was sent in the room.
    this._lastMessageTime = Date.now();

    // Keep track of when the last prompt was broadcast.
    this._lastPromptTime = 1;

    this._state = STATES.PREGAME;
}

method.playerCount = function() {
    return this.humans.size + this.bots.size;
}

method.addHuman = function(human) {
    if (!this.isFull()) {
        this.humans.add(human);
        var id = this._remainingPlayerIds.pop();
        this._playerToId.set(human, id);
        this._idToPlayer.set(id, human);
    } else {
        throw new Error("Room is already full.");
    }
}

method.addBot = function(bot) {
    if (!this.isFull()) {
        this.bots.add(bot);
        var id = this._remainingPlayerIds.pop();
        this._playerToId.set(bot, id);
        this._idToPlayer.set(id, bot);
    } else {
        console.log("Room is already full, so bot will not be added.");
    }
}

method.remove = function(player) {
    // If we've already started the game, we can't just remove a player.
    // Otherwise, the player will be gone during voting and null pointers
    // will happen and everyone will be sad.
    if (this._state === STATES.PREGAME) {
        if (this.humans.has(player)) {
            this.humans.delete(player);
        } else {
            this.bots.delete(player);
        }
        var id = this._playerToId.get(player);
        this._remainingPlayerIds.push(id);
        this._playerToId.delete(player);
        this._idToPlayer.delete(id);
    }
}

method.isFull = function() {
    // Make sure there aren't any disconnected players.
    this.removeDisconnectedPlayers();
    return (this.playerCount() >= this.maxSize);
}

/* Remove players that are no longer connected (web socket status: closing
 * or closed). */
method.removeDisconnectedPlayers = function() {
    var room = this;
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.CLOSING
            || client.readyState === WebSocket.CLOSED) {
            room.remove(client);
        }
    });
}

method.broadcast = function(message, sender) {
    // Trim the message length, if needed.
    message = message.substring(0, MAX_MESSAGE_LENGTH);

    this._lastMessageTime = Date.now();

    var payload = message;
    if (sender) {
        id = this._playerToId.get(sender);
        payload = JSON.stringify({"playerMessage": {"id": id, "message": message}});
    }
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });

    this.bots.forEach(function each(bot) {
        if (sender != bot) { // do not message self
            bot.send(message, sender);
        }
    });
}

/* Sends a message to each client that gameplay is starting. Also tell
 * what player ID they are so they know which icon to use. */
method.signalStart = function() {
    var room = this; // "this" changes inside the loop
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            var obj = {
                'start': true,
                'playerId': room._playerToId.get(client),
                'players': JSON.stringify(room._shuffledPlayerIdList())
            };
            client.send(JSON.stringify(obj));
        }
    });
    this._lastMessageTime = Date.now();
    this.promptIfInactive();
    this._state = STATES.GAME;
}

/* Randomize the order from insertion order (i.e. the order in which players
 * joined the game). */
method._shuffledPlayerIdList = function() {
    var ids = [...this._idToPlayer.keys()];
    ids.sort(function() {return 0.5 - Math.random()});
    return ids;
}

/* Mark a player as ready to vote. */
method.setPlayerAsReady = function(client, isReady) {
    this.readyMap.set(client, isReady);
    if (this.isReadyToVote()) {
        // Signal vote after a random delay so that it's not obvious for the
        // last person who checked "ready to vote".
        var that = this;
        setTimeout(function() {
            that.signalVote();
        }, 5000 + Math.random() * 5000);
    }
}

method.isReadyToVote = function() {
    // If every member is ready to vote, return true. False otherwise.
    var readyMap = this.readyMap;
    var ready = true;
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN && (!readyMap.has(client) || !readyMap.get(client))) {
            ready = false;
        }
    });
    return ready;
}

/* Broadcast to each player that we are ready to vote. */
method.signalVote = function() {
    this.broadcast(JSON.stringify({'startVoting': true}));
    this._state = STATES.VOTING;
}

method.submitBallot = function(client, ballot) {
    this._ballots.set(client, ballot);
    if (this.everyoneHasVoted()) {
        this.broadcastResults();
    }
}

method.everyoneHasVoted = function() {
    var ballots = this._ballots;
    var ready = true;
    this.humans.forEach(function each(client) {
        if (!ballots.has(client) && client.readyState === WebSocket.OPEN) {
            ready = false;
        }
    });
    return ready;
}

method.broadcastResults = function() {
    var payload = JSON.stringify({"results": this.tallyVotes()});
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
    this._state = STATES.RESULTS;
}

method.tallyVotes = function() {
    // Initialize the object of votes.
    var results = {};
    // Initialize the result for each player, including their identity.
    for (var id of this._idToPlayer.keys()) {
        results[id] = {"human": 0, "robot": 0, "score": 0}; // vote count

        if (this.humans.has(this._idToPlayer.get(id))) {
            results[id]["identity"] = "human";
        } else {
            results[id]["identity"] = "robot";
        }
    }

    // Iterate through the ballots to compute scores.
    for (var voter of this._ballots.keys()) {
        var voterId = this._playerToId.get(voter);

        var ballot = this._ballots.get(voter);
        for (var voteeId in ballot) {
            var guess = ballot[voteeId];
            if (guess == "human" || guess == "robot") {
                // Update the vote count for the votee.
                results[voteeId][guess]++;

                // Update points for the voter and the votee.
                if (guess == results[voteeId]["identity"]) {
                    // If the voter guessed the votee correctly
                    results[voterId]["score"] += SCORES.GUESS_RIGHT;
                    results[voteeId]["score"] += SCORES.IS_GUESSED_RIGHT;
                } else {
                    // If the voter guessed wrong
                    results[voterId]["score"] += SCORES.GUESS_WRONG;
                    results[voteeId]["score"] += SCORES.IS_GUESSED_WRONG;
                }
            }
        }
    }

    return results;
}

/* Returns the ID of the player, which is also the player's display name. */
method.getPlayerName = function(player) {
    return this._playerToId.get(player);
}

method.promptIfInactive = function() {
    // If the proper time has elapsed, send a prompt.
    if (Date.now() - this._lastMessageTime >= PROMPT_SILENCE_DURATION_MS &&
        Date.now() - this._lastPromptTime >= PROMPT_COOLDOWN_MS) {
        this.sendPrompt();
    }

    // Check again later.
    var that = this;
    setTimeout(function() {that.promptIfInactive()}, PROMPT_SILENCE_DURATION_MS);
}

method.sendPrompt = function() {
    this._lastMessageTime = Date.now();
    this._lastPromptTime = Date.now();

    // Get the first prompt from the list and then rotate it to the end of the list.
    var prompt = this._prompts[0];
    this._prompts.push(this._prompts.shift());

    var payload = JSON.stringify({"prompt": prompt});
    this.humans.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });

    this.bots.forEach(function each(bot) {
        bot.send(prompt, null);
    });
}

module.exports = Room;
