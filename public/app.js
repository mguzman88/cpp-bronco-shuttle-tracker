

import { initializeApp } from
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";

import {
  getDatabase,
  ref,
  set,
  remove,
  onValue,
  onDisconnect,
  get
} from
  "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";


const firebaseConfig = {
  apiKey: "AIzaSyBBj7QzADbGA6cHJ-6HQyK46eyLcD3d37U",
  authDomain: "cpp-bronco-shuttle-tracker.firebaseapp.com",
  projectId: "cpp-bronco-shuttle-tracker",
  storageBucket: "cpp-bronco-shuttle-tracker.firebasestorage.app",
  messagingSenderId: "1043286751344",
  appId: "1:1043286751344:web:027c94987b021e10d51cb5",
  measurementId: "G-59Z8ZVSSWT",
  databaseURL: "https://cpp-bronco-shuttle-tracker-default-rtdb.firebaseio.com",
};

const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

const riderId = crypto.randomUUID();

const riderLocationRef = ref(
  database,
  `activeRiders/${riderId}`
);
onDisconnect(riderLocationRef)
  .remove()
  .catch(error => {
    console.error(
      "Could not register disconnect cleanup:",
      error
    );
  });


const map = L.map("map", {
  maxBoundsViscosity: 1.0,
  minZoom: 14,
  maxZoom: 19,
}).setView([34.057, -117.821], 15);

const ROUTE_LIMIT_METERS = 150;
const GRACE_PERIOD_MS = 7 * 60 * 1000;
const SPEED_TOLERANCE_MPS = 3;

const MAX_ROUTE_DISTANCE_METERS = 150;
const MAX_GPS_ACCURACY_METERS = 75;
const MAX_LOCATION_AGE_MS = 30000;

const AVERAGE_SHUTTLE_SPEED_MPH = 10;
const METERS_PER_MILE = 1609.34;

let estimatedShuttlePosition = null;

let routeCoordinates = [];
let previousRiderPosition = null;
let offRouteSince = null;
let speedMismatchSince = null;

const activeRidersRef = ref(
  database,
  "activeRiders"
);
const STALE_RIDER_MS = 7* 60 * 1000;

async function cleanupStaleRiders() {
  try {
    const snapshot = await get(activeRidersRef);
    const riders = snapshot.val() || {};
    const now = Date.now();

    for (const [riderId, rider] of Object.entries(riders)) {
      const isStale =
        !rider.updatedAt ||
        now - rider.updatedAt > STALE_RIDER_MS;

      if (isStale) {
        await remove(
          ref(database, `activeRiders/${riderId}`)
        );

        console.log(`Removed stale rider: ${riderId}`);
      }
    }
  } catch (error) {
    console.error("Stale rider cleanup failed:", error);
  }
}

cleanupStaleRiders();

setInterval(
  cleanupStaleRiders,
  60 * 1000
);

const shuttleStatus = 
  document.querySelector("#shuttle-status");

const shuttleUpdated =
  document.querySelector("#shuttle-updated");


////

  

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 19
}).addTo(map);

const stops = [
  {
    name: "Student Service Building shuttle stop",
    latitude: 34.0582062,
    longitude: -117.8182075
  },
  {
    name: "Building 89",
    latitude: 34.0608299,
    longitude: -117.8118397
  },
  {
    name: "Lot B shuttle Stop",
    latitude: 34.0528697,
    longitude: -117.8154263
  },
  {
    name: "Parking Structure 2 Shuttle Stop",
    latitude: 34.051552,
    longitude: -117.8199064
  },
  {
    name: "Collins College Shuttle Stop",
    latitude: 34.0553552,
    longitude: -117.824877
  },
  {
    name: "Building 7 Shuttle Stop",
    latitude: 34.0570684,
    longitude: -117.8277685
  },
  {
    name: "Building 94 Shuttle Stop",
    latitude: 34.0595328,
    longitude: -117.8234631
  },
  {
    name: "Rose Garden Shuttle Stop",
    latitude: 34.0612267,
    longitude: -117.8210255
  },
  {
    name: "Parking Structure 1 Shuttle Stop",
    latitude: 34.0600136,
    longitude: -117.8181737
  },
  {
    name: "Current Apartments",
    latitude: 34.064004,
    longitude: -117.802806
  },
  {
    name: "CPP Village",
    latitude: 34.0495731,
    longitude: -117.8169576
  }

];

stops.forEach((stop, index) => {
  L.circleMarker(
    [stop.latitude, stop.longitude],
    {
      radius: 7,
      color: "#174a2e",
      weight: 2,
      fillColor: "#f9c74f",
      fillOpacity: 1
    }
  )
    .addTo(map)
    .bindPopup(`
      <strong>${stop.name}</strong>
        <br>
        <span id="eta-stop-${index}">
          Waiting for shuttle location...
        </span>
    `)
    .on("popupopen", updateStopETAs);
});
//
let sharedShuttleMarker = null;

onValue(activeRidersRef, snapshot => {
  const riders = snapshot.val() || {};

  console.log("Active riders:", riders);

  const now = Date.now();

const locations = Object.values(riders).filter(rider => {
  if (
    rider.latitude === undefined ||
    rider.longitude === undefined
  ) {
    return false;
  }

  const distanceFromRoute = distanceToRoute(
    rider.latitude,
    rider.longitude
  );

  const isNearRoute =
    distanceFromRoute <= MAX_ROUTE_DISTANCE_METERS;

  const hasGoodAccuracy =
    rider.accuracy === undefined ||
    rider.accuracy <= MAX_GPS_ACCURACY_METERS;

  const isRecent =
    rider.updatedAt === undefined ||
    now - rider.updatedAt <= MAX_LOCATION_AGE_MS;

  return isNearRoute && hasGoodAccuracy && isRecent;
});

console.log("Valid rider locations:", locations);

if (locations.length === 0) {
    if (sharedShuttleMarker) {
      map.removeLayer(sharedShuttleMarker);
      sharedShuttleMarker = null;
    }

    shuttleStatus.textContent =
      "No active shuttle location available.";

    shuttleUpdated.textContent =
      "Waiting for location...";

    return;
  }

  const averageLatitude =
    locations.reduce((total, rider) =>
      total + rider.latitude, 0
    ) / locations.length;

  const averageLongitude =
    locations.reduce((total, rider) =>
      total + rider.longitude, 0
    ) / locations.length;

  const shuttlePosition = [
    averageLatitude,
    averageLongitude
  ];

  shuttleStatus.textContent =
  `Estimated shuttle location based on ${locations.length} rider(s).`;

  const latestUpdatedAt = Math.max(
  ...locations.map(rider => rider.updatedAt || 0)
  );

  if (latestUpdatedAt > 0) {
    const updatedTime =
      new Date(latestUpdatedAt).toLocaleTimeString();

    shuttleUpdated.textContent =
      `Last updated at ${updatedTime}`;
  }

  estimatedShuttlePosition = {
  latitude: averageLatitude,
  longitude: averageLongitude
  };

updateStopETAs();

  if (!sharedShuttleMarker) {
    sharedShuttleMarker = L.circleMarker(
      shuttlePosition,
      {
        radius: 12,
        color: "#ffffff",
        weight: 3,
        fillColor: "#d62828",
        fillOpacity: 1
      }
    )
      .addTo(map)
      .bindPopup("Estimated Shuttle Location");
  } else {
    sharedShuttleMarker.setLatLng(shuttlePosition);
  }
});
function updateNearestStop(
  latitude,
  longitude
) {
  let closestStop = null;
  let closestDistance = Infinity;

  stops.forEach(stop => {
    const distance = distanceMeters(
      latitude,
      longitude,
      stop.latitude,
      stop.longitude
    );

    if (distance < closestDistance) {
      closestDistance = distance;
      closestStop = stop;
    }
  });

  if (closestStop) {
    const distanceInMeters =
      Math.round(closestDistance);

    nearestStopStatus.textContent =
      `Nearest stop: ${closestStop.name} ` +
      `(${distanceInMeters} meters away)`;
  }
}

//
const routeSelect =
  document.querySelector("#route-select");

let campusRouteLayer = null;
let apartmentRouteLayer = null;

let campusRouteCoordinates = [];
let apartmentRouteCoordinates = [];

function showSelectedRoute() {
  const selectedRoute =
    routeSelect.value;

  console.log(
    "Selected route:",
    selectedRoute
  );
  console.log(
  "Apartment layer exists:",
  apartmentRouteLayer !== null
  );

  if (campusRouteLayer) {
    map.removeLayer(campusRouteLayer);
  }

  if (apartmentRouteLayer) {
    map.removeLayer(apartmentRouteLayer);
  }

  let selectedLayer;
  let selectedCoordinates;

  if (selectedRoute === "apartments") {
    selectedLayer = apartmentRouteLayer;
    selectedCoordinates =
      apartmentRouteCoordinates;
  } else {
    selectedLayer = campusRouteLayer;
    selectedCoordinates =
      campusRouteCoordinates;
  }

  if (!selectedLayer) {
    console.error(
      "Selected route has not finished loading."
    );
    return;
  }

  selectedLayer.addTo(map);

  routeCoordinates =
    selectedCoordinates;

  const selectedBounds =
    selectedLayer.getBounds().pad(0.15);

  map.setMaxBounds(selectedBounds);

  map.fitBounds(selectedBounds, {
    padding: [25, 25]
  });
}

routeSelect.addEventListener(
  "change",
  showSelectedRoute
);

fetch("bronco-shuttle-route.geojson")
  .then(response => {
    if (!response.ok) {
      throw new Error(
        `Could not load campus route: ${response.status}`
      );
    }

    return response.json();
  })
  .then(route => {
    campusRouteCoordinates =
      route.features[0].geometry.coordinates;

    campusRouteLayer = L.geoJSON(route, {
      style: {
        color: "#f28c28",
        weight: 6,
        opacity: 0.9
      }
    });

    showSelectedRoute();
  })
  .catch(error => {
    console.error("Campus route error:", error);
  });

fetch("bronco-shuttle-apartments.geojson")
  .then(response => {
    if (!response.ok) {
      throw new Error(
        `Could not load apartment route: ${response.status}`
      );
    }

    return response.json();
  })
  .then(route => {
    const apartmentFeature =
      route.features.find(
        feature =>
          feature.geometry &&
          feature.geometry.type === "LineString"
      );

    if (!apartmentFeature) {
      throw new Error(
        "No LineString route found in apartment GeoJSON."
      );
    }

    apartmentRouteCoordinates =
      apartmentFeature.geometry.coordinates;

    apartmentRouteLayer = L.geoJSON(
      apartmentFeature,
      {
        style: {
          color: "#2563eb",
          weight: 6,
          opacity: 0.9
        }
      }
    );
    console.log(
    "Apartment route loaded:",
    apartmentRouteCoordinates.length,
    "coordinates"
    );

    console.log(
    "Selected value:",
    routeSelect.value
    );
    

    showSelectedRoute();




  })
  .catch(error => {
    console.error("Apartment route error:", error);
  });

function distanceMeters(
  latitude1,
  longitude1,
  latitude2,
  longitude2
) {
  const earthRadius = 6371000;

  const lat1 = latitude1 * Math.PI / 180;
  const lat2 = latitude2 * Math.PI / 180;

  const latDifference =
    (latitude2 - latitude1) * Math.PI / 180;

  const lonDifference =
    (longitude2 - longitude1) * Math.PI / 180;

  const value =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos(lat1) *
    Math.cos(lat2) *
    Math.sin(lonDifference / 2) ** 2;

  return earthRadius * 2 *
    Math.atan2(
      Math.sqrt(value),
      Math.sqrt(1 - value)
    );
}

function distanceToRoute(latitude, longitude) {
  if (routeCoordinates.length === 0) {
    return 0;
  }

  return Math.min(
    ...routeCoordinates.map(
      ([routeLongitude, routeLatitude]) =>
        distanceMeters(
          latitude,
          longitude,
          routeLatitude,
          routeLongitude
        )
    )
  );
}

function nearestRouteIndex(latitude, longitude) {
  let closestIndex = 0;
  let closestDistance = Infinity;

  routeCoordinates.forEach(
    ([routeLongitude, routeLatitude], index) => {
      const distance = distanceMeters(
        latitude,
        longitude,
        routeLatitude,
        routeLongitude
      );

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    }
  );

  return closestIndex;
}

function routeDistanceToStop(
  currentLatitude,
  currentLongitude,
  stopLatitude,
  stopLongitude
) {
  if (routeCoordinates.length < 2) {
    return 0;
  }

  const currentIndex = nearestRouteIndex(
    currentLatitude,
    currentLongitude
  );

  const stopIndex = nearestRouteIndex(
    stopLatitude,
    stopLongitude
  );

  let totalDistance = 0;
  let index = currentIndex;
  let steps = 0;

  while (
    index !== stopIndex &&
    steps < routeCoordinates.length
  ) {
    const nextIndex =
      (index + 1) % routeCoordinates.length;

    const [longitude1, latitude1] =
      routeCoordinates[index];

    const [longitude2, latitude2] =
      routeCoordinates[nextIndex];

    totalDistance += distanceMeters(
      latitude1,
      longitude1,
      latitude2,
      longitude2
    );

    index = nextIndex;
    steps++;
  }

  return totalDistance;
}

function updateStopETAs() {
  if (!estimatedShuttlePosition) {
    return;
  }

  stops.forEach((stop, index) => {
    const distance = routeDistanceToStop(
      estimatedShuttlePosition.latitude,
      estimatedShuttlePosition.longitude,
      stop.latitude,
      stop.longitude
    );

    const miles = distance / METERS_PER_MILE;

    const minutes = Math.max(
      1,
      Math.ceil(
        (miles / AVERAGE_SHUTTLE_SPEED_MPH) * 60
      )
    );

    const etaElement = document.querySelector(
      `#eta-stop-${index}`
    );

    if (etaElement) {
      etaElement.textContent =
        `Estimated arrival: ${minutes} minutes`;
    }
  });
}

  //simulation for shuttle movements 
let locationWatchId = null;
let studentLocationMarker = null;

const startLocationButton = document.querySelector("#start-location");
const stopLocationButton = document.querySelector("#stop-location");
const locationStatus = document.querySelector("#location-status");
const nearestStopStatus =
  document.querySelector("#nearest-stop");

function startLocationSharing() {
  if (!navigator.geolocation) {
    locationStatus.textContent =
      "Geolocation is not supported by this browser.";
    return;
  }

  locationStatus.textContent = "Requesting location permission...";
  startLocationButton.disabled = true;
  stopLocationButton.disabled = false;

  locationWatchId = navigator.geolocation.watchPosition(
    position => {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      updateNearestStop(
        latitude,
        longitude
      );

      const now = Date.now();

      const distanceFromRoute =
        distanceToRoute(latitude, longitude);

      const isOffRoute =
        distanceFromRoute > ROUTE_LIMIT_METERS;

      if (isOffRoute) {
        if (offRouteSince === null) {
      offRouteSince = now;
      }
    } else {
      offRouteSince = null;
    }

if (
  offRouteSince !== null &&
  now - offRouteSince >= GRACE_PERIOD_MS
) {
  locationStatus.textContent =
    "Sharing stopped because you left the route.";

  nearestStopStatus.textContent =
    "Nearest stop: Start sharing your location.";

  stopLocationSharing();
  return;
}

      set(riderLocationRef, {
        latitude: latitude,
        longitude: longitude,
        accuracy: position.coords.accuracy,
        updatedAt: Date.now()
      });
        then(() => {
          console.log("Location updated in Firebase.");
        })
        .catch(error => {
          console.error("Error updating location:", error);
        });

      if (!studentLocationMarker) {
        studentLocationMarker = L.circleMarker(
          [latitude, longitude],
          {
            radius: 9,
            color: "#ffffff",
            weight: 3,
            fillColor: "#1769e0",
            fillOpacity: 1
          }
        )
          .addTo(map)
          .bindPopup("Your location");
      } else {
        studentLocationMarker.setLatLng([
          latitude,
          longitude
        ]);
      }

      locationStatus.textContent = "Location sharing is on.";
    },

    error => {
      console.error("Location error:", error);
      stopLocationSharing();

      if (error.code === 1) {
        locationStatus.textContent =
          "Location permission was denied.";
      } else {
        locationStatus.textContent =
          "Unable to get your location.";
      }
    },

    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    }
  );
}

function stopLocationSharing() {
  if (locationWatchId !== null) {
    navigator.geolocation.clearWatch(locationWatchId);
    locationWatchId = null;
  }

  remove(riderLocationRef);

  if (studentLocationMarker !== null) {
    map.removeLayer(studentLocationMarker);
    studentLocationMarker = null;
  }

  startLocationButton.disabled = false;
  stopLocationButton.disabled = true;
  locationStatus.textContent = "Location sharing is off.";
}
startLocationButton.addEventListener(
  "click",
  startLocationSharing
);

stopLocationButton.addEventListener(
  "click",
  stopLocationSharing
);


    

