import 'package:cleanlet/components/inlet_carousel.dart';
import 'package:cleanlet/components/inlet_intro.dart';
import 'package:flutter/material.dart';
import 'package:map_launcher/map_launcher.dart';
import '../models/inlet.dart';

class InletAdminReview extends StatelessWidget {
  final Inlet inlet;

  const InletAdminReview({super.key, required this.inlet});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
        appBar: AppBar(title: Text('Inlet Under Review')),
        body: SafeArea(
            child: Column(children: [
          Container(margin: const EdgeInsets.only(bottom: 20.0), child: InletCarousel(referenceId: inlet.referenceId)),
          Container(margin: const EdgeInsets.symmetric(horizontal: 20.0), child: InletIntro(coords: Coords(inlet.geoLocation.latitude, inlet.geoLocation.longitude), description: inlet.description, address: inlet.address)),
          const Spacer(),
          Container(
            margin: EdgeInsets.symmetric(horizontal: 20.0),
            padding: EdgeInsets.all(16.0),
            decoration: BoxDecoration(
              color: Colors.lightBlue[100],
              borderRadius: BorderRadius.circular(12.0),
            ),
            child: Text('This inlet is currently under review. Please check back later.', style: TextStyle(color: Colors.lightBlue[800])),
          )
        ])));
  }
}
