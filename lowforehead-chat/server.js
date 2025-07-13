const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const ADMIN_NICK = 'Lowf0rehe@d'; // Ton pseudo admin
const CHANNEL_NAME = 'Lowforehead Online Support';
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// État du serveur
let users = new Map();
let recording = false;
let recordBuffer = [];
let recordStartTime = null;
let bannedUsers = new Set();

// Classes utilisateur
class User {
  constructor(id, nick, role = 'guest') {
    this.id = id;
    this.nick = this.sanitizeNick(nick);
    this.role = role;
    this.connected = new Date();
    this.lastActivity = new Date();
  }
  
  sanitizeNick(nick) {
    // Nettoie le pseudo et limite la longueur
    return nick.trim().substring(0, 20).replace(/[<>\"'/\\]/g, '');
  }
}

// Fonctions utilitaires
function getUserByNick(nick) {
  for (let [id, user] of users) {
    if (user.nick.toLowerCase() === nick.toLowerCase()) {
      return user;
    }
  }
  return null;
}

function getRoleColor(role) {
  switch(role) {
    case 'admin': return '#ff0000';
    case 'op': return '#ff9999';
    case 'mod': return '#0066cc';
    case 'user': return '#66ccff';
    case 'guest': return '#66ff66';
    default: return '#ffffff';
  }
}

function formatMessage(type, data) {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  return {
    type,
    timestamp,
    ...data
  };
}

function recordMessage(message) {
  if (recording) {
    recordBuffer.push({
      timestamp: new Date().toISOString(),
      message
    });
  }
}

function saveRecording() {
  if (recordBuffer.length === 0) return null;
  
  try {
    const logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const filename = `chat-log-${recordStartTime.toISOString().replace(/:/g, '-').split('.')[0]}.json`;
    const logPath = path.join(logsDir, filename);
    
    fs.writeFileSync(logPath, JSON.stringify(recordBuffer, null, 2));
    return filename;
  } catch (error) {
    console.error('Erreur sauvegarde logs:', error);
    return null;
  }
}

function sanitizeMessage(text) {
  return text.trim().substring(0, 500).replace(/[<>]/g, '');
}

function isValidNick(nick) {
  return nick && 
         nick.trim().length > 0 && 
         nick.length <= 20 && 
         /^[a-zA-Z0-9_@\-\[\]\\^{}|`]+$/.test(nick);
}

// Route pour l'interface web
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API pour obtenir les stats
app.get('/api/stats', (req, res) => {
  res.json({
    users: users.size,
    recording: recording,
    uptime: process.uptime(),
    channel: CHANNEL_NAME
  });
});

// Gestionnaire de connexion
io.on('connection', (socket) => {
  let currentUser = null;
  console.log(`Nouvelle connexion: ${socket.id}`);
  
  // Connexion avec pseudo
  socket.on('join', (nick) => {
    try {
      if (!isValidNick(nick)) {
        socket.emit('error', 'Pseudo invalide (3-20 caractères, alphanumériques uniquement)');
        return;
      }
      
      // Vérifier les bans
      if (bannedUsers.has(nick.toLowerCase())) {
        socket.emit('error', 'Tu es banni de ce chat');
        return;
      }
      
      // Vérifier si le pseudo est déjà pris
      if (getUserByNick(nick)) {
        socket.emit('error', 'Ce pseudo est déjà utilisé');
        return;
      }
      
      // Créer l'utilisateur
      let role = 'guest';
      if (nick.toLowerCase() === ADMIN_NICK.toLowerCase()) {
        role = 'admin';
      }
      
      currentUser = new User(socket.id, nick, role);
      users.set(socket.id, currentUser);
      
      // Rejoindre le channel
      socket.join(CHANNEL_NAME);
      
      // Notifier la connexion
      socket.emit('joined', {
        channel: CHANNEL_NAME,
        user: currentUser,
        users: Array.from(users.values()),
        motd: 'Bienvenue sur le chat Lowforehead ! Tape /help pour les commandes.'
      });
      
      // Notifier les autres
      socket.broadcast.emit('message', formatMessage('join', {
        nick: currentUser.nick,
        role: currentUser.role
      }));
      
      io.emit('userList', Array.from(users.values()));
      
      recordMessage({type: 'join', nick: currentUser.nick, role: currentUser.role});
      console.log(`${nick} (${role}) a rejoint le chat`);
      
    } catch (error) {
      console.error('Erreur lors de la connexion:', error);
      socket.emit('error', 'Erreur lors de la connexion');
    }
  });
  
  // Gestion des messages
  socket.on('message', (text) => {
    if (!currentUser) return;
    
    try {
      const cleanText = sanitizeMessage(text);
      if (!cleanText) return;
      
      // Update last activity
      currentUser.lastActivity = new Date();
      
      // Vérifier si c'est une commande
      if (cleanText.startsWith('/')) {
        handleCommand(socket, currentUser, cleanText);
      } else {
        // Message normal
        const msg = formatMessage('message', {
          nick: currentUser.nick,
          role: currentUser.role,
          text: cleanText
        });
        
        io.emit('message', msg);
        recordMessage(msg);
      }
    } catch (error) {
      console.error('Erreur traitement message:', error);
      socket.emit('error', 'Erreur lors de l\'envoi du message');
    }
  });
  
  // Ping/pong pour maintenir la connexion
  socket.on('ping', () => {
    socket.emit('pong');
    if (currentUser) {
      currentUser.lastActivity = new Date();
    }
  });
  
  // Déconnexion
  socket.on('disconnect', () => {
    if (currentUser) {
      console.log(`${currentUser.nick} s'est déconnecté`);
      users.delete(socket.id);
      
      socket.broadcast.emit('message', formatMessage('quit', {
        nick: currentUser.nick,
        reason: 'Déconnexion'
      }));
      
      io.emit('userList', Array.from(users.values()));
      
      recordMessage({type: 'quit', nick: currentUser.nick});
    }
  });
});

// Gestionnaire de commandes
function handleCommand(socket, user, text) {
  const parts = text.split(' ');
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  
  try {
    switch(command) {
      case '/help':
      case '/list':
        const commands = [
          '/help ou /list - Affiche cette liste',
          '/nick <nouveau_pseudo> - Change ton pseudo',
          '/me <action> - Action RP',
          '/msg <pseudo> <message> - Message privé',
          '/who - Liste des utilisateurs connectés',
          '/time - Heure du serveur',
          '/quit [raison] - Quitter le chat'
        ];
        
        if (user.role === 'admin' || user.role === 'op' || user.role === 'mod') {
          commands.push(
            '/kick <pseudo> [raison] - Expulser un utilisateur',
            '/ban <pseudo> [raison] - Bannir un utilisateur',
            '/unban <pseudo> - Débannir un utilisateur'
          );
        }
        
        if (user.role === 'admin') {
          commands.push(
            '/op <pseudo> - Donner les droits OP',
            '/deop <pseudo> - Retirer les droits OP',
            '/mod <pseudo> - Nommer modérateur',
            '/demod <pseudo> - Retirer modérateur',
            '/user <pseudo> - Passer en utilisateur connecté',
            '/startrecord - Commencer l\'enregistrement',
            '/stoprecord - Arrêter l\'enregistrement',
            '/stats - Statistiques du serveur'
          );
        }
        
        socket.emit('message', formatMessage('system', {
          text: 'Commandes disponibles:\n' + commands.join('\n')
        }));
        break;
        
      case '/nick':
        if (args.length === 0) {
          socket.emit('error', 'Usage: /nick <nouveau_pseudo>');
          return;
        }
        
        const newNick = args[0];
        if (!isValidNick(newNick)) {
          socket.emit('error', 'Pseudo invalide');
          return;
        }
        
        if (getUserByNick(newNick)) {
          socket.emit('error', 'Ce pseudo est déjà pris');
          return;
        }
        
        const oldNick = user.nick;
        user.nick = newNick;
        
        io.emit('message', formatMessage('nick', {
          oldNick: oldNick,
          newNick: newNick
        }));
        
        io.emit('userList', Array.from(users.values()));
        recordMessage({type: 'nick', oldNick, newNick});
        break;
        
      case '/me':
        if (args.length === 0) return;
        
        const action = formatMessage('action', {
          nick: user.nick,
          role: user.role,
          text: args.join(' ')
        });
        
        io.emit('message', action);
        recordMessage(action);
        break;
        
      case '/msg':
        if (args.length < 2) {
          socket.emit('error', 'Usage: /msg <pseudo> <message>');
          return;
        }
        
        const targetNick = args[0];
        const privateMsg = args.slice(1).join(' ');
        const target = getUserByNick(targetNick);
        
        if (!target) {
          socket.emit('error', 'Utilisateur non trouvé');
          return;
        }
        
        socket.emit('message', formatMessage('private', {
          from: user.nick,
          to: target.nick,
          text: privateMsg,
          sent: true
        }));
        
        io.to(target.id).emit('message', formatMessage('private', {
          from: user.nick,
          to: target.nick,
          text: privateMsg,
          sent: false
        }));
        break;
        
      case '/who':
        const usersList = Array.from(users.values())
          .map(u => `${u.nick} (${u.role})`)
          .join(', ');
        
        socket.emit('message', formatMessage('system', {
          text: `Utilisateurs connectés (${users.size}): ${usersList}`
        }));
        break;
        
      case '/time':
        socket.emit('message', formatMessage('system', {
          text: `Heure du serveur: ${new Date().toLocaleString('fr-FR')}`
        }));
        break;
        
      case '/kick':
        if (!['admin', 'op', 'mod'].includes(user.role)) {
          socket.emit('error', 'Permission refusée');
          return;
        }
        
        if (args.length === 0) {
          socket.emit('error', 'Usage: /kick <pseudo> [raison]');
          return;
        }
        
        const kickTarget = getUserByNick(args[0]);
        if (!kickTarget) {
          socket.emit('error', 'Utilisateur non trouvé');
          return;
        }
        
        if (kickTarget.role === 'admin') {
          socket.emit('error', 'Impossible de kicker l\'admin');
          return;
        }
        
        const kickReason = args.slice(1).join(' ') || 'Aucune raison donnée';
        
        io.emit('message', formatMessage('kick', {
          nick: kickTarget.nick,
          by: user.nick,
          reason: kickReason
        }));
        
        io.to(kickTarget.id).emit('kicked', kickReason);
        const kickSocket = io.sockets.sockets.get(kickTarget.id);
        if (kickSocket) {
          kickSocket.disconnect();
        }
        
        recordMessage({type: 'kick', nick: kickTarget.nick, by: user.nick, reason: kickReason});
        break;
        
      case '/ban':
        if (!['admin', 'op', 'mod'].includes(user.role)) {
          socket.emit('error', 'Permission refusée');
          return;
        }
        
        if (args.length === 0) {
          socket.emit('error', 'Usage: /ban <pseudo> [raison]');
          return;
        }
        
        const banTarget = getUserByNick(args[0]);
        const banNick = args[0].toLowerCase();
        
        if (banNick === ADMIN_NICK.toLowerCase()) {
          socket.emit('error', 'Impossible de bannir l\'admin');
          return;
        }
        
        bannedUsers.add(banNick);
        const banReason = args.slice(1).join(' ') || 'Aucune raison donnée';
        
        io.emit('message', formatMessage('ban', {
          nick: args[0],
          by: user.nick,
          reason: banReason
        }));
        
        if (banTarget) {
          io.to(banTarget.id).emit('banned', banReason);
          const banSocket = io.sockets.sockets.get(banTarget.id);
          if (banSocket) {
            banSocket.disconnect();
          }
        }
        
        recordMessage({type: 'ban', nick: args[0], by: user.nick, reason: banReason});
        break;
        
      case '/unban':
        if (!['admin', 'op', 'mod'].includes(user.role)) {
          socket.emit('error', 'Permission refusée');
          return;
        }
        
        if (args.length === 0) {
          socket.emit('error', 'Usage: /unban <pseudo>');
          return;
        }
        
        const unbanNick = args[0].toLowerCase();
        bannedUsers.delete(unbanNick);
        
        io.emit('message', formatMessage('system', {
          text: `${args[0]} a été débanni par ${user.nick}`
        }));
        break;
        
      case '/op':
      case '/deop':
      case '/mod':
      case '/demod':
      case '/user':
        if (user.role !== 'admin') {
          socket.emit('error', 'Seul l\'admin peut modifier les rôles');
          return;
        }
        
        if (args.length === 0) {
          socket.emit('error', `Usage: ${command} <pseudo>`);
          return;
        }
        
        const roleTarget = getUserByNick(args[0]);
        if (!roleTarget) {
          socket.emit('error', 'Utilisateur non trouvé');
          return;
        }
        
        let newRole;
        switch(command) {
          case '/op': newRole = 'op'; break;
          case '/deop': newRole = roleTarget.role === 'op' ? 'user' : roleTarget.role; break;
          case '/mod': newRole = 'mod'; break;
          case '/demod': newRole = roleTarget.role === 'mod' ? 'user' : roleTarget.role; break;
          case '/user': newRole = 'user'; break;
        }
        
        const oldRole = roleTarget.role;
        roleTarget.role = newRole;
        
        io.emit('message', formatMessage('role', {
          nick: roleTarget.nick,
          oldRole: oldRole,
          newRole: newRole,
          by: user.nick
        }));
        
        io.emit('userList', Array.from(users.values()));
        recordMessage({type: 'role', nick: roleTarget.nick, oldRole, newRole, by: user.nick});
        break;
        
      case '/stats':
        if (user.role !== 'admin') {
          socket.emit('error', 'Seul l\'admin peut voir les stats');
          return;
        }
        
        const uptime = Math.floor(process.uptime());
        const stats = [
          `Utilisateurs connectés: ${users.size}`,
          `Enregistrement: ${recording ? 'Actif' : 'Inactif'}`,
          `Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
          `Mémoire: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
          `Utilisateurs bannis: ${bannedUsers.size}`
        ];
        
        socket.emit('message', formatMessage('system', {
          text: 'Statistiques du serveur:\n' + stats.join('\n')
        }));
        break;
        
      case '/startrecord':
        if (user.role !== 'admin') {
          socket.emit('error', 'Seul l\'admin peut enregistrer');
          return;
        }
        
        if (recording) {
          socket.emit('error', 'Enregistrement déjà en cours');
          return;
        }
        
        recording = true;
        recordStartTime = new Date();
        recordBuffer = [];
        
        io.emit('message', formatMessage('system', {
          text: '🔴 Enregistrement commencé par ' + user.nick
        }));
        break;
        
      case '/stoprecord':
        if (user.role !== 'admin') {
          socket.emit('error', 'Seul l\'admin peut arrêter l\'enregistrement');
          return;
        }
        
        if (!recording) {
          socket.emit('error', 'Aucun enregistrement en cours');
          return;
        }
        
        recording = false;
        const filename = saveRecording();
        
        io.emit('message', formatMessage('system', {
          text: filename ? 
            `⏹️ Enregistrement terminé. Sauvegardé dans: ${filename}` :
            '⏹️ Enregistrement terminé (erreur de sauvegarde)'
        }));
        break;
        
      case '/quit':
        const quitReason = args.join(' ') || 'Départ volontaire';
        
        io.emit('message', formatMessage('quit', {
          nick: user.nick,
          reason: quitReason
        }));
        
        socket.emit('quit');
        socket.disconnect();
        break;
        
      default:
        socket.emit('error', 'Commande inconnue: ' + command + '. Tape /help pour la liste des commandes.');
    }
  } catch (error) {
    console.error('Erreur dans handleCommand:', error);
    socket.emit('error', 'Erreur lors de l\'exécution de la commande');
  }
}

// Nettoyage périodique des utilisateurs inactifs
setInterval(() => {
  const now = new Date();
  const timeout = 30 * 60 * 1000; // 30 minutes
  
  for (let [id, user] of users) {
    if (now - user.lastActivity > timeout) {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        socket.emit('message', formatMessage('system', {
          text: 'Déconnexion pour inactivité'
        }));
        socket.disconnect();
      }
    }
  }
}, 5 * 60 * 1000); // Check toutes les 5 minutes

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promise rejetée:', reason);
});

// Démarrer le serveur
server.listen(PORT, () => {
  console.log(`🚀 Serveur IRC Lowforehead démarré sur le port ${PORT}`);
  console.log(`📂 Interface web: http://localhost:${PORT}`);
  console.log(`👑 Admin: ${ADMIN_NICK}`);
});