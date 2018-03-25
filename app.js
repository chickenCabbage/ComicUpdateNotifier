require("dotenv").config({path: "../heroku-deploy.env"}); //environment vars

var scrapeIntervalTime = 2 * 60 * 1000; //two minutes, the interval between each checks
var eol = require("os").EOL; //local system's end of line character
var fs = require("fs"); //file IO

var insp = require("node-metainspector");
var praceClient = new insp("http://praguerace.com/", { //crawling config
	timeout: 9999, //maximal reply time in ms. 9999 ~= 10 seconds
	headers: { //custom headers for the request
		"User-Agent": "praceScraper/update.js" //user agent
	}
});
var tigerClient = new insp("http://tigertigercomic.com/", {
	timeout: 9999,
	headers: {
		"User-Agent": "tigerScraper/update.js"
	}
});
var blogClient = new insp("http://leppucomics.com//", {
	timeout: 9999,
	headers: {
		"User-Agent": "blogScraper/update.js"
	}
});

var mysql = require("mysql"); //MySQL API
var con = mysql.createPool({
	host: process.env.MYSQL_HOST,
	user: process.env.MYSQL_USER,
	password: process.env.MYSQL_PASSWORD, //log in
	database: process.env.MYSQL_DATABASE //USE command
});
console.log("MySQL prepared on " + process.env.MYSQL_HOST + ".");

function querySQL(cmd, data) {
	var dataPromise = new Promise(function(resolve, reject) {
		con.query(cmd, data, function(err, result) {
			if(err) throw err;
			resolve(result);
		});
	});
	console.log("MySQL query queued.");
	return dataPromise;
} //end querySQL()

var nodemailer = require("nodemailer");
function sendMail(recip, subject, content) {
	var mailOptions = {
		from: process.env.MAILER_USERNAME,
		to: recip,
		subject: subject,
		html: content
	};

	var transporter = nodemailer.createTransport({
		service: process.env.MAILER_SERVICE,
		auth: {
			"user": process.env.MAILER_USERNAME,
			"pass": process.env.EMAIL_PASSWORD
		}
	});
	transporter.sendMail(mailOptions, function(error, info){
		if(error) console.log("Error in mailing!\n" + error);
		console.log("Email sent.");
	});
}//end sendMail()
console.log("SMTP prepared as " + process.env.MAILER_USERNAME + ".");

var MailListener = require("mail-listener2"); //email API
var mailListener = new MailListener({
	username: process.env.EMAIL_LISTENER_USERNAME,
	password: process.env.EMAIL_PASSWORD, //log in
	host: process.env.EMAIL_LISTENER_HOST,
	port: process.env.EMAIL_IMAP_PORT,
	tls: process.env.EMAIL_IMAP_TLS,
	mailbox: "INBOX",
	markSeen: true
});
 
mailListener.start(); //start listening 

 mailListener.on("server:connected", function() {
	console.log("IMAP is ready as " + process.env.EMAIL_LISTENER_USERNAME + ".");
});
mailListener.on("server:disconnected", function() {
	console.log("Disconnected from email!");
	mailListener.stop();
	mailListener.start(); //reconnect
	console.log("Restarted email connection.");
});

mailListener.on("mail", function(mail, seqno, attributes) {
	var from = []; //for passing data into MySQL
	from[0] = mail.from[0].address; //isolate the email address
	var subject = mail.headers.subject.toLowerCase().trim();
	console.log("\nMail recieved from " + from[0] + ": " + subject);
	try { //for general error catching
		var comicsList = "", subUnsub = "";
		try { //for catching errors from the subject processing
			//subject format:
			//subscribe/unsubscribe: comicname, comicname, comicname
			//secure the subject for to-array splitting:
			while(subject.includes("'")) {
				subject = subject.replace("'", "APOSTROPHE").toString();
			}
			while(subject.includes("\\")) {
				subject = subject.replace("\\", "BACKSLASH").toString();
			}
			while(subject.includes('"')) {
				subject = subject.replace('"', "QUOTE").toString();
			}
			while(subject.includes(";")) {
				subject = subject.replace(";", "SEMICOLON").toString();
			}
			while(subject.includes("+")) {
				subject = subject.replace("+", "PLUS").toString();
			}
			//isolate "comicname"s:
			comicsList = subject.split(":")[1].toString().trim().split(",");
			//isolate "subscribe/unsubscribe":
			subUnsub = subject.split(":")[0].toString().trim();
		}
		catch(error) { //catch #1
			if(!error.name == "TypeError") { //if it's not an underfined send an error message, if it is then it's not in-format
				sendMail(
					from[0],
					"An error occured!",
					"Please resend the email, you weren't been added or removed from the list. Here's what we know:<br>" +
					error + "<br>" +
					"<br>If this continues and you aren't contacted by an admin, please send a non-command email " +
					"or reply to this one. You can contact the main admin personally at " + process.env.ADMIN_ADDR + "."
				);
				sendMail(
					process.env.ADMIN_ADDR,
					"An error has occured in the update notifier",
					"Catch #1 has thrown an error: " +
					"<br>Error type: " + error.name +
					"<br>Error message: " + error.message +
					"<br>Full error:<br><br>" + JSON.stringify(error).toString()
				);
				return;
			} //end if(!error.name == "TypeError")
		} //end catch #1

		if(subUnsub != "subscribe" && subUnsub != "unsubscribe") {
			//non-understandabe action!
			//if it's not a known command but it sounds like one:
			//if it has "be" in the end or starts with "su" or "uns", and it's between 6 and 15 characters long
			if((subUnsub.startsWith("su") || subUnsub.startsWith("uns") || subUnsub.endsWith("be")) && (subUnsub.length > 6 && subUnsub.length < 15))
				//then it's a typo!
				sendMail( //send a general message
					from[0],
					"You may have misspelled your email title",
					"The system has detected a possible typo in your command! " +
					"You wrote " + subUnsub + " instead of \"subscribe\" or \"unsubscribe\"." +
					"<br>This is an automated response. Consider changing the title and re-sending if the matter is urgent."
				);
			else //it's not a typo: forward it to admin
				sendMail(
					process.env.ADMIN_ADDR,
					mail.headers.subject,
					from[0] + " wrote to " + process.env.EMAIL_LISTENER_USERNAME + ":<br><br>" +
					mail.html.toString()
				);
			return;
		}
		//go over each "comicname":
		for(counter = 0; counter < comicsList.length; counter ++) {
			comicMailHandler(counter, comicsList, mail, from, subject, subUnsub); //what a botch, but it works
		}
	} //end try
	catch(error) { //send a genereal error message, catch #2
		sendMail(
			from[0],
			"An error occured!",
			"Please resend the email, you weren't been added or removed from the list. Here's what we know:<br>" +
			error + "<br>" +
			"<br>If this continues and you aren't contacted by an admin, please send a non-command email" +
			"or reply to this one. You can contact the main admin personally at " +
			process.env.ADMIN_ADDR + "."
		);
		sendMail(
			process.env.ADMIN_ADDR,
			"An error has occured in the update notifier",
			"Catch #2 has thrown an error: " +
			"<br>Error type: " + error.name +
			"<br>Error message: " + error.message +
			"<br>Full error:<br><br>" + JSON.stringify(error).toString()
		);
	}
}); //end mailListener.on("mail")

function comicMailHandler(counter, comicsList, mail, from, subject, subUnsub) {
	var comicTable = ""; //the table that the user is going to be inserted into or removed from
	var comicName = "";
	switch(comicsList[counter].toString().trim()) { //understand which comic it is
		case "prague race":
		case "praguerace":
		case "prace":
		case "pr":
			comicTable = "praceReaders";
			comicName = "Prague Race";
			break;

		case "tiger tiger!":
		case "tiger tiger":
		case "tigertiger!":
		case "tigertiger":
		case "tt":
			comicTable = "tigerReaders";
			comicName = "Tiger, Tiger";
			break;

		case "leppuAPOSTROPHEs blog": //looks funny, is actually just "leppu's blog"
		case "leppus blog":
		case "leppu":
		case "blog":
			comicTable = "blogReaders";
			comicName = "Leppu's blog";
			break;

		default:
			sendMail(
				from[0],
				"Comic not recognized!",
				"The system didn't recognize your comic request. You wrote " + comicsList[counter] +
				", which doesn't match the known comics." +
				"<br>You may have mis-spelled the comic name, " +
				"but if you haven't and you'd like to request that it be added then send a non-command email" +
				" and your request will be responded to as soon as possible."
			);
			return;
	} //end switch(comicsList[counter])

	var isSubbedCmd = "SELECT * FROM " + comicTable + " WHERE email = ?;"; //check if the user is subbed to the comic
	querySQL(isSubbedCmd, from)
	.then(function(isSubbedResolve) { //wait for the isSubbed query
		if(isSubbedResolve.length == 0) { //if there were no results, that means that the user wasn't subbed to the comic
			if(subUnsub == "subscribe") { //if they were trying to subscribe
				var actionCmd = "INSERT INTO " + comicTable + " (email) VALUES (?);"; //add the user
				querySQL(actionCmd, from)
				.then(function(addResolve) { //adding went smoothly
					console.log("Added " + from[0] + " to " + comicName + ".");
					sendMail( //inform them they're in
						from[0],
						"Signup complete",
						"Thank you for signing up to the update notifier for " + comicName + "." +
						"<br>If you have questions please reply to this email."
					);
				})
				.catch(function(addReject) { //error occured in adding
					console.log("An error occured during subscribing!");
					console.log(addReject);
					console.log();
					//an error was thrown during the action. ask the user to resend:
					sendMail(
						from[0],
						"An error occured!",
						"Please resend the email, you weren't been added or removed from the list. Here's what we know:<br>" +
						addReject + "<br>" +
						"You tried to " + subUnsub + " to/from " + comicName + "." + 
						"<br><br>If this continues and you aren't contacted by an admin, please send a non-command email" +
						" or reply to this one. You can contact the main admin personally at " +
						process.env.ADMIN_ADDR + "."
					);
					sendMail(
						process.env.ADMIN_ADDR,
						"An error has occured in the update notifier",
						"The INSERT query was rejected!" +
						"<br>addReject = <br>" + 
						addReject
					);
				}); //end action reject and querySQL() call
			}
			else { //if they're tring to unsubscribe
				console.log(from[0] + " tried to unsubscribe from " + comicName + ", but wasn't subscribed.");
				sendMail(
					from[0],
					"You aren't subscribed",
					"You weren't in the mailing list for " + comicName + " in the first place." +
					"<br>If you have something you'd like to say, " + 
					"you can reply to this email or send a non-command email."
				);
			}
		} //end if(isSubbedResolve.length == 0)
		else { //the user is already subbed
			if(subUnsub == "subscribe") {
				console.log(from[0] + " tried to subscribe to " + comicName + ", but was already in.");
				sendMail(
					from[0],
					"You're already subscribed!",
					"You're already in the mailing list for the update notifier for " + comicName  + "."
				);
			}
			else {
				var actionCmd = "DELETE FROM " + comicTable + " WHERE email = ?;";
				querySQL(actionCmd, from)
				.then(function(removeResolve) {
					console.log(from[0] + " was removed from " + comicName + "\'s mailing list.");
					sendMail(
						from[0],
						"Unsubscribed",
						"Thanks for using the update notifier for " + comicName + ", we're sorry to see you go." +
						"<br>If you'd like to give feedback or tell us why you unsubscribed please do.");
				})
				.catch(function(removeReject) {
					console.log("An error occured during unsubscribing!");
					console.log(removeReject);
					console.log();
					//an error was thrown during the action. ask the user to resend:
					sendMail(
						from[0],
						"An error occured!",
						"Please resend the email, you weren't been added or removed from the list. Here's what we know:<br>" +
						addReject + "<br>" +
						"You tried to " + subUnsub + " to/from " + comicName + "." + 
						"<br><br>If this continues and you aren't contacted by an admin, please send a non-command email" +
						" or reply to this one. You can contact the main admin personally at " +
						process.env.ADMIN_ADDR + "."
					);
					sendMail(
						process.env.ADMIN_ADDR,
						"An error has occured in the update notifier",
						"The DELETE query was rejected!" +
						"<br>removeReject = <br>" + 
						removeReject
					);
				});
			}
		}
	}) //end isSubbed resolve
	.catch(function(isSubbedReject) { //if the query fails
		console.log("An error occured during the check!");
		console.log(isSubbedReject);
		console.log();
		sendMail(
			from[0],
			"An error occured!",
			"Please resend the email, you weren't been added or removed from the list. Here's what we know:<br>" +
			isSubbedReject + "<br>" +
			"You tried to " + subUnsub + " to/from " + comicName + "." + 
			"<br><br>If this continues and you aren't contacted by an admin, please send a non-command email" +
			"or reply to this one. You can contact the main admin personally at " +
			process.env.ADMIN_ADDR + "."
		);
		sendMail(
			process.env.ADMIN_ADDR,
			"An error has occured in the update notifier",
			"The SELECT query was rejected!" +
			"<br>isSubbedReject = <br>" + 
			isSubbedReject
		);
	}); //end isSubbed reject and querySQL() call
} //end comicMailHandler()

var http = require("http");
var port = process.env.PORT || 7000;
var forbiddenFiles = []; //no special forbidden files
var landingPage = "./index.html"; //the page you get when you request "/"

http.createServer(function(request, response) { //on every request to the server:
	var url = request.url;
	switch(url.toLowerCase()) {
		case "/":
			response.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
			response.end(fs.readFileSync(landingPage).toString()); //serve the requseted file
			break;

		case "/favicon.ico":
			response.writeHead(200, {"Content-Type": "image/x-icon"});
			response.end(fs.readFileSync("./favicon.ico").toString()); //serve the requseted file
			break;

		case "/praguerace":
		case "/prace":
		case "/pr":
		case "/prague%20race":
			response.writeHead(200, {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"});
			response.end(fs.readFileSync("./data/pracedata.txt").toString()); //serve the requseted file
			break;

		case "/tigertiger":
		case "/ttiger":
		case "/tt":
		case "/tiger%20tiger":
		case "/tiger,%20tiger":
		case "/tiger,%20tiger!":
			response.writeHead(200, {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"});
			response.end(fs.readFileSync("./data/ttigerdata.txt").toString()); //serve the requseted file
			break;

		case "/lepppusblog":
		case "/leppus%27sblog":
		case "/leppus%27s%20blog":
		case "/leppu":
			response.writeHead(200, {"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"});
			response.end(fs.readFileSync("./data/leppudata.txt").toString()); //serve the requseted file
			break;

		default:
			try {
				response.writeHead(200, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
				response.end(fs.readFileSync("." + url).toString()); //serve the requseted file
			}
			catch(error) {
				response.writeHead(500, {"Content-Type": "text/html", "Access-Control-Allow-Origin": "*"});
				response.end("An error occured.<br>" + error); //serve the requseted file
				console.log(error.name);
				console.log(error.message);
			}
	}
}).listen(port); //end http.createServer()
console.log("Listening on port " + port + ".");

function handleFetch(comicAbrv, scrapeClient) {
	var dataFile = "", comicName = "", tableName = "", emailPage = "", realTitle = "";
	switch(comicAbrv) {
		case "prace":
			dataFile = "./data/pracedata.txt";
			comicName = "Prague Race";
			tableName = "praceReaders";
			emailPage = "./emails/praceUpdateEmail.html"
			realTitle = scrapeClient.title;
			break;

		case "ttiger":
			dataFile = "./data/ttigerdata.txt";
			comicName = "Tiger, Tiger";
			tableName = "tigerReaders";
			emailPage = "./emails/ttigerUpdateEmail.html";
			realTitle = scrapeClient.title;
			break;

		case "leppu":
			dataFile = "./data/leppudata.txt";
			comicName = "Leppu's blog";
			tableName = "blogReaders";
			emailPage = "./emails/leppuUpdateEmail.html";
			realTitle = scrapeClient.parsedDocument(".cc-blogtitle").html();
			realTitle = realTitle.split(">")[1].toString().split("<")[0];
			break;
	}
	try {
		var updateTitle = fs.readFileSync(dataFile).toString().split(eol)[1]; //read the current data
		if(realTitle != updateTitle) { //if the title changed - new page!
			updateTitle = realTitle;
			console.log("\n" + comicName.toUpperCase() + " UPDATED! " + updateTitle); //woo

			var updateTime = "", panelSrc = "", leppuComment = "";
			switch(comicAbrv) { //get each comic according to its site layout
				case "prace":
					updateTime = scrapeClient.parsedDocument(".cc-publishtime").html(); //the div content
					updateTime = updateTime.split("Posted ")[1] + " EST"; //remove excess HTML/data
					updateTime = updateTime.toString().replace("pm", "PM").toString().replace("am", "AM").toString();
					panelSrc = scrapeClient.images[0];
					break;

				case "ttiger":
					updateTime = scrapeClient.parsedDocument(".cc-publishtime").html(); //the div content
					console.log("updateTime = " + updateTime);
					updateTime = updateTime.split("Posted ")[1] + " EST"; //remove excess HTML/data
					console.log("updateTime = " + updateTime);
					updateTime = updateTime.toString().replace("pm", "PM").toString().replace("am", "AM").toString();
					console.log("updateTime = " + updateTime);
					panelSrc = scrapeClient.images[1];
					break;

				case "leppu":
					leppuComment = scrapeClient.parsedDocument(".cc-blogcontent").html();
					leppuComment = leppuComment.split("<br>");
					leppuComment = leppuComment[leppuComment.length - 1];
					panelSrc = scrapeClient.images[6];
					updateTime = leppuComment;
					break;
			}

			fs.writeFile(dataFile, updateTime + eol + updateTitle + eol + panelSrc, function() { //change the file data
				console.log("Updated file.");
			}); //change pracedata.txt

			var cmd = "SELECT * FROM " + tableName + ";";
			querySQL(cmd) //get all the people on the reading list
			.then(function(getUsersResolve) {
				var allEmails = [];
				for(i = 0; i < getUsersResolve.length; i ++) { //for every row in the table
					allEmails[i] = getUsersResolve[i].email;
				}

				sendMail(
					allEmails.toString(),
					comicName + " has just updated!",
					fs.readFileSync(emailPage).toString()
					.replace("TITLEME", updateTitle)
					.replace("TIMEME", updateTime)
					.replace("SRCME", panelSrc)
				);
			})
			.catch(function(getUsersReject) { //catch for SELECT
				console.log(comicName + " updates couldn't get the users:");
				console.log(getUsersReject);
				sendMail(
					process.env.ADMIN_ADDR,
					"COULDN'T SEND UPDATE MAIL",
					comicName.toUpperCase() + " UPDATED AND THE SYSTEM WASN'T ABLE TO SEND AN EMAIL!" + 
					"<br>getUsersReject = <br>" +
					getUsersReject
				);
			});
		}//end if
	}//end try
	catch(error) {
		console.log(comicName + "'s client couldn't fetch!");
		console.log(error);
		sendMail(
			process.env.ADMIN_ADDR,
			"An error has occured!",
			comicName + "'s client couldn't fetch!<br>" +
			error
		);
	}
} //end handleFetch()

function handleScrapeClientError(error, comicAbrv, scrapeClient) {
	var comicName = "";
	switch(comicAbrv) {
		case "prace":
			comicName = "Prague Race";
			break;

		case "ttiger":
			comicName = "Tiger, Tiger";
			break;

		case "leppu":
			comicName = "Leppu's blog";
			break;
	}

	console.log(comicName + "'s client threw an error!");
	console.log(error);
	sendMail(
		process.env.ADMIN_ADDR,
		"An error has occured!",
		"The " + comicName + "client threw an error!<br>" +
		error
	);
} //end handleScrapeClientError()

praceClient.on("fetch", function() {
	handleFetch("prace", praceClient)
});
tigerClient.on("fetch", function() {
	handleFetch("ttiger", tigerClient)
});
blogClient.on("fetch", function() {
	handleFetch("leppu", blogClient)
});

praceClient.on("error", function() {
	handleScrapeClientError(error, "prace", praceClient)
});
tigerClient.on("error", function() {
	handleScrapeClientError("ttiger", tigerClient)
});
blogClient.on("error", function() {
	handleScrapeClientError("leppu", blogClient)
});

if(((scrapeIntervalTime / 1000) / 60) > 1)  //it will return a fraction if it's less than a minute
	console.log("Checking at interval of " + (scrapeIntervalTime / 1000) + " seconds.");
else  //otherwise it'll be larger/equal to 1
	console.log("Checking for updates at interval of " + ((scrapeIntervalTime / 1000) / 60) + " minutes.");

function keepAlive() {
	var options = { //JSON config
		host: process.env.ADDRESS,
		path: "/keepAlive"
	};
	http.request(options).end();
	console.log("ADDRESS = " + process.env.ADDRESS);
} //end keepAlive()

praceClient.fetch(); //initialization
tigerClient.fetch();
blogClient.fetch();

var counter = 0;
setInterval(function() { //do this every [scrapeIntervalTime] miliseconds
	praceClient.fetch();
	tigerClient.fetch();
	blogClient.fetch();
	counter ++;
	//if you've waited for 
	if(counter * (scrapeIntervalTime / (60 * 1000)) > 5) { //if you've gone for 27 minutes without a keepAlive() call
		counter = 0;
		keepAlive(); /////////TESTING KEEPALIVE
	}
}, scrapeIntervalTime);